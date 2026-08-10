'use strict';
// Thin, defensive wrapper around @sentry/node.
//
// Design goals:
//  - Never break the app. Sentry is initialised lazily inside try/catch, and
//    every exported function is a no-op when Sentry is unavailable or the DSN
//    is not configured. A telemetry failure must never affect device operation.
//  - No global process handlers. We use `defaultIntegrations: false` so Sentry
//    does NOT install uncaughtException/unhandledRejection handlers (those can
//    exit the process) - Homey has its own crash reporting. We only send
//    explicit captures.
//  - Anonymous. No PII is sent: `sendDefaultPii` is false and `beforeSend`
//    strips the hostname and any user object. Tags are limited to app version,
//    Homey firmware version, Node version and (per event) device/driver info.
//
// The DSN is read from env.json as `SENTRY_DSN` via `Homey.env`. If it is
// empty/missing, telemetry stays disabled.

let Sentry = null;
let enabled = false;
let initialized = false;
// Per-key rate limiting state: { last, interval, sent }.
const rateLimits = new Map();

// Rate limiting uses escalating backoff per key.
//
// A recurring problem is almost always the same install reporting the same
// broken device over and over (an inverter that is switched off, a wrong IP, or
// Modbus TCP that was never enabled). Those never self-heal without user action,
// so after the first couple of events every further one costs quota and adds no
// signal. Each repeat for a key therefore waits BACKOFF_FACTOR times longer than
// the previous one, from MIN_INTERVAL up to MAX_INTERVAL: roughly 6h, 24h, 4d,
// then weekly, instead of every 6h forever.
//
// The first event for a key is always sent immediately, so genuinely new
// breakage still shows up straight away.
const DEFAULT_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;       // 6 hours
const DEFAULT_MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days
const DEFAULT_BACKOFF_FACTOR = 4;

/**
 * Initialise Sentry from the app's env.json DSN. Safe to call once from the
 * app's onInit. Returns true when telemetry is active.
 * @param {import('homey').Homey} homey
 * @returns {boolean}
 */
function init(homey) {
    if (initialized) {
        return enabled;
    }
    initialized = true;

    try {
        // Read the DSN from env.json. Prefer the instance accessor, but fall
        // back to the static `Homey.env` - the reliable way to read env.json in
        // SDK v3 (`homey.env` is often undefined).
        let dsn = (homey && homey.env && homey.env.SENTRY_DSN) || '';
        if (!dsn) {
            try {
                const Homey = require('homey');
                dsn = (Homey && Homey.env && Homey.env.SENTRY_DSN) || '';
            } catch (_) {
                // Not running under the Homey runtime (e.g. a local unit test).
            }
        }

        if (!dsn || typeof dsn !== 'string' || dsn.trim() === '') {
            return false; // Not configured -> disabled.
        }

        // Lazy require so a load/compat failure disables telemetry instead of
        // crashing the app.
        Sentry = require('@sentry/node');

        const appVersion = (homey && homey.manifest && homey.manifest.version) || 'unknown';
        let homeyVersion = 'unknown';
        try {
            homeyVersion = homey.version || 'unknown';
        } catch (_) { /* ignore */ }

        Sentry.init({
            dsn: dsn.trim(),
            release: appVersion,
            // NOTE: intentionally not setting `environment` to the Homey firmware
            // version - that lands every event under an environment like "12.4.5",
            // which Sentry's default (environment-filtered) view can hide. Firmware
            // is a tag below instead, so events show up and stay filterable.
            // Explicit captures only; keep the footprint minimal and never touch
            // global process handlers.
            defaultIntegrations: false,
            tracesSampleRate: 0,
            sendDefaultPii: false,
            beforeSend(event) {
                try {
                    delete event.server_name; // don't leak the hostname
                    // Keep only the (pseudonymous) Homey id for counting distinct
                    // affected Homeys, and force ip_address to null so Sentry does
                    // not geolocate from the request IP.
                    const id = event.user && event.user.id;
                    event.user = { id: id || undefined, ip_address: null };
                } catch (_) { /* ignore */ }
                return event;
            }
        });

        try {
            Sentry.setTags({ appVersion, homeyVersion, nodeVersion: process.version });
        } catch (_) { /* ignore */ }

        // Identify events by the unique Homey id so Sentry's "Users" count reflects
        // how many distinct Homeys are affected. Fetched in the background (async);
        // the first telemetry event is minutes away, so it will be set in time.
        try {
            if (homey && homey.cloud && typeof homey.cloud.getHomeyId === 'function') {
                Promise.resolve(homey.cloud.getHomeyId())
                    .then((id) => {
                        if (id) {
                            Sentry.setUser({ id: String(id), ip_address: null });
                        }
                    })
                    .catch(() => { /* ignore - user id is best effort */ });
            }
        } catch (_) { /* ignore */ }

        enabled = true;
        return true;
    } catch (_) {
        // Any failure (missing package, incompatible Node, bad DSN) -> disabled.
        Sentry = null;
        enabled = false;
        return false;
    }
}

function isEnabled() {
    return enabled;
}

/**
 * Report a message, rate-limited per `key` with escalating backoff. No-op when
 * disabled.
 *
 * @param {string} key                 Unique key for rate limiting (e.g. per device).
 * @param {string} message             Human-readable message / issue title.
 * @param {object} [options]
 * @param {string} [options.level]     Sentry level (default 'warning').
 * @param {object} [options.tags]      Indexed tags (deviceType, driver, ...).
 * @param {object} [options.extra]     Additional non-indexed context.
 * @param {number} [options.minIntervalMs]  Wait before the first repeat for this key.
 * @param {number} [options.maxIntervalMs]  Ceiling the backoff grows to.
 * @param {number} [options.backoffFactor]  Interval multiplier per repeat (1 disables backoff).
 * @returns {boolean} true when an event was sent.
 */
function report(key, message, options = {}) {
    if (!enabled || !Sentry) {
        return false;
    }
    const {
        level = 'warning',
        tags = {},
        extra = {},
        minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
        maxIntervalMs = DEFAULT_MAX_INTERVAL_MS,
        backoffFactor = DEFAULT_BACKOFF_FACTOR
    } = options;
    try {
        const now = Date.now();
        const state = rateLimits.get(key);

        if (state && now - state.last < state.interval) {
            return false;
        }

        // First event goes out immediately and only arms the minimum interval;
        // each subsequent one widens the gap towards the ceiling.
        const interval = state
            ? Math.min(Math.max(state.interval * backoffFactor, minIntervalMs), maxIntervalMs)
            : minIntervalMs;
        const sent = (state ? state.sent : 0) + 1;

        rateLimits.set(key, { last: now, interval, sent });

        Sentry.captureMessage(message, {
            level,
            tags,
            // `occurrence` distinguishes a first-time report from a long-standing
            // one, which the escalating backoff would otherwise obscure.
            extra: { ...extra, occurrence: sent, nextReportAfterHours: interval / 3600000 }
        });
        return true;
    } catch (_) {
        // never throw
        return false;
    }
}

/**
 * Clear rate limiting state. Intended for tests.
 */
function resetRateLimits() {
    rateLimits.clear();
}

/**
 * Capture an exception. No-op when disabled.
 * @param {Error} error
 * @param {object} [options]
 * @param {object} [options.tags]
 * @param {object} [options.extra]
 */
function captureException(error, options = {}) {
    if (!enabled || !Sentry) {
        return;
    }
    const { tags = {}, extra = {} } = options;
    try {
        Sentry.captureException(error, { tags, extra });
    } catch (_) {
        // never throw
    }
}

/**
 * Flush pending events (call on app shutdown).
 * @param {number} [timeout]
 */
async function flush(timeout = 2000) {
    if (!enabled || !Sentry) {
        return;
    }
    try {
        await Sentry.flush(timeout);
    } catch (_) {
        // never throw
    }
}

module.exports = { init, isEnabled, report, resetRateLimits, captureException, flush };
