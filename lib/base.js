'use strict';

const deviceType = require('./deviceType.js');
const HomeyEventEmitter = require('./homeyEventEmitter.js');
const utilFunctions = require('./util.js');
const { getRegisterBuffer, formatSocketError } = require('./modbus/utils.js');
const logger = require('./logger.js');
const net = require('net');
const Modbus = require('jsmodbus');

// Default per-request Modbus timeout (ms) when the `timeout` setting is unset,
// e.g. on devices created before the setting existed.
const DEFAULT_TIMEOUT_MS = 5000;

// Modbus unit id for the Sigenergy "system" register space (plant-level values).
// A second client is created on this unit id for device types that expose
// SYSTEM registries.
const SYSTEM_UNIT_ID = 247;

// Read-coalescing bounds. Contiguous registers within MODBUS_MAX_COALESCE_GAP
// registers of each other are fetched in a single readHoldingRegisters call, up
// to MODBUS_MAX_COALESCE_RUN registers per read (the Modbus spec caps a read at
// 125 registers). Bridging small gaps lets a range span a few reserved holes.
const MODBUS_MAX_COALESCE_GAP = 8;
const MODBUS_MAX_COALESCE_RUN = 120;

// How much evidence it takes to conclude that the device will never answer a
// particular read, rather than that the transport happened to fail.
//
// A silent timeout is indistinguishable from a dead connection at the point it
// happens, so both counters only advance while the same connection has already
// had a successful read (see #connectionHasAnswered) - i.e. the device is
// demonstrably answering us, just not this. Demoting a range is cheap and only
// costs round-trips, so one strike is enough. Dropping a register loses data, so
// it takes repeated strikes across separate connections.
const RUN_STRIKES_BEFORE_DEMOTING = 1;
const REGISTER_STRIKES_BEFORE_SKIPPING = 3;

// Cap on how many register ids are named in the device setting, which is a
// single-line label. The full set is always in the session snapshot.
const MAX_REPORTED_SKIPPED_REGISTERS = 6;

const SESSION_CANCELLED_CODE = 'BASE_SESSION_CANCELLED';

/**
 * Render a millisecond span as a short human duration ("45s", "12m", "3h 12m").
 * Reporting only, so readability beats precision.
 */
function formatDuration(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    if (totalSeconds < 60) {
        return `${totalSeconds}s`;
    }

    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) {
        return `${totalMinutes}m`;
    }

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

class Base extends HomeyEventEmitter {
    options = {};
    deviceRegistryType = null;
    #connectionTimeout = DEFAULT_TIMEOUT_MS; // Per-request/connection timeout in ms
    #socket = null;
    #modbusClient = null;
    #systemModbusClient = null;
    #pollIntervalId = null;
    #healthCheckIntervalId = null;
    #pendingConnect = null;
    #connectionGeneration = 0;
    #stopped = false;
    #isReconnecting = false;
    #isPolling = false;
    #infoRegistriesRead = false;
    #backoffState = null; // { attempts, nextRetryTime } | null
    // registryId -> comment for registers currently failing to read. The comment
    // is carried so a session snapshot can name them, not just number them.
    #failedRegisters = new Map();
    // Run keys ("start:count") the device rejected as a single range read, so we
    // stop attempting to coalesce them and read those registers individually.
    // Per-connection: re-learning costs one extra failed read, so there is no
    // reason to carry a transient rejection forward.
    #coalesceBlocklist = new Set();
    // Reads the device answered with silence rather than an exception.
    //
    // These three survive #cleanupConnection, unlike the two above, because a
    // silent read is classified as a poisoned transport and forces a reconnect -
    // so re-learning it costs a full reconnect and an availability drop, and
    // discarding it means the next connection issues the identical read and
    // fails identically. That is a loop the device cannot leave.
    //
    // Strike keys are "run:start:count" or "reg:registryId".
    #timeoutStrikes = new Map();
    #demotedRuns = new Set();
    #skippedRegisters = new Map(); // registryId -> comment
    // Whether the current connection has had at least one successful read. Only
    // then is a silent read attributable to the read itself rather than to the
    // connection, so this gates every strike.
    #connectionHasAnswered = false;
    // Last skipped-register list handed to the device, so an unchanged list is
    // not re-emitted on every poll.
    #reportedSkipList = null;
    // Log-once flags, reset per connection so a recurring condition is reported
    // on each new session but not on every poll in between.
    #slowPollReported = false;
    #readPlanLogged = new Set();
    // When the current transport connected, and how many times it has been
    // rebuilt. Only used for reporting: a snapshot needs to say how long this
    // has been up and how unstable it has been, which is history the log window
    // may no longer reach back to.
    #connectedAt = null;
    #reconnectCount = 0;
    // Sliding window of recent serious-error timestamps, used to detect a
    // sustained failure state and report it (rate-limited) for blast-radius
    // telemetry. Reset each time the threshold is reached, so #errorCount is
    // what carries the cumulative severity.
    #errorTimestamps = [];
    #errorCount = 0;

    constructor(deviceRegistryType, options) {
        super();

        if (!deviceRegistryType) {
            this._logError('deviceRegistryType is mandatory input');
            throw new Error('deviceRegistryType is mandatory input');
        }
        this.deviceRegistryType = deviceRegistryType;
        this.deviceTypeName = deviceRegistryType.name || deviceRegistryType.constructor.name;
        this.options = options;

        // Resolve the per-request Modbus timeout (seconds -> ms). Falls back to
        // the default when unset or invalid.
        const timeoutSeconds = Number(options?.timeout);
        this.#connectionTimeout = (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0)
            ? timeoutSeconds * 1000
            : DEFAULT_TIMEOUT_MS;
    }

    /**
     * Switch detailed logging on or off for a live session.
     *
     * Applied to the running session rather than requiring a reconnect, so a
     * user can enable logging, reproduce the problem and capture a diagnostic
     * report without the act of enabling it resetting the very state being
     * investigated (failed register tracking, backoff, uptime).
     *
     * Switching it on replays everything that is otherwise only said once, at
     * connect. Homey keeps a bounded number of log lines, so unless the user
     * happens to restart the app just before submitting a diagnostic report, the
     * startup lines have long since rolled out of the window - and those are the
     * lines carrying the connection parameters, the device's own description of
     * itself, and any register failure that has been in effect for hours.
     *
     * So enabling logging emits a session snapshot immediately, and resets the
     * log-once state so the read plans and INFO registers are re-emitted on the
     * next poll.
     */
    setDebug(enabled) {
        const enabling = enabled === true && this.options.debug !== true;
        this.options.debug = enabled === true;

        if (enabling) {
            this.#readPlanLogged.clear();
            this.#infoRegistriesRead = false;
            this.#logSessionSnapshot();
        }
    }

    /**
     * Restate the current session in full: what we are talking to, how stable
     * that has been, and which registers are currently not answering.
     *
     * All of this is already reported as it happens, but only once, at the
     * moment it happens. This is the version that survives a log window that no
     * longer reaches back that far.
     */
    #logSessionSnapshot() {
        const connected = this.#isConnected(this.#modbusClient) ? 'connected' : 'not connected';
        const uptime = this.#connectedAt
            ? formatDuration(Date.now() - this.#connectedAt)
            : 'n/a';

        this._logMessage('DEBUG', '--- session snapshot (detailed logging enabled) ---');
        this._logMessage('DEBUG', `Device type ${this.deviceTypeName}, `
            + `target ${this.options.host}:${this.options.port}, `
            + `unit id ${this.options.modbus_unitId}, `
            + `refresh ${this.options.refreshInterval}s, `
            + `timeout ${this.#connectionTimeout / 1000}s`);
        this._logMessage('DEBUG', `Transport ${connected} for ${uptime}, `
            + `${this.#reconnectCount} reconnect(s) this session, `
            + `${this.#errorCount} error(s) recorded`
            + (this.#backoffState
                ? `, backing off after ${this.#backoffState.attempts} failed attempt(s)`
                : ''));

        // "none" is worth stating: it separates "no register is failing" from
        // "we did not look".
        const failed = [...this.#failedRegisters.entries()]
            .map(([registryId, comment]) => `${registryId} (${comment})`);
        this._logMessage('DEBUG', `Registers currently failing to read: ${failed.length ? failed.join(', ') : 'none'}`);

        const blocklisted = [...this.#coalesceBlocklist, ...this.#demotedRuns];
        this._logMessage('DEBUG', `Ranges demoted to per-register reads: ${blocklisted.length ? blocklisted.join(', ') : 'none'}`);

        // Unlike the two above, these persist across reconnects, so this is the
        // only place a report can learn that a register stopped being asked for
        // hours ago and why the value behind it is missing.
        const skipped = [...this.#skippedRegisters.entries()]
            .map(([registryId, comment]) => `${registryId} (${comment})`);
        this._logMessage('DEBUG', `Registers no longer read (unanswered): ${skipped.length ? skipped.join(', ') : 'none'}`);

        const strikes = [...this.#timeoutStrikes.entries()]
            .map(([key, count]) => `${key} x${count}`);
        this._logMessage('DEBUG', `Unanswered-read strikes: ${strikes.length ? strikes.join(', ') : 'none'}`);
    }

    async initialize() {
        if (this.#stopped) {
            return;
        }

        // The connection parameters are the first thing needed when reading a
        // diagnostic report, so they are INFO rather than DEBUG. Once per
        // session.
        this._logMessage('INFO', `Connecting to ${this.options.host}:${this.options.port} `
            + `(unit id ${this.options.modbus_unitId}, refresh ${this.options.refreshInterval}s, `
            + `timeout ${this.#connectionTimeout / 1000}s)`);

        try {
            this.options = await this.#validateOptions(this.options);
            this.#throwIfStopped();
            await this.#initListenersAndConnect();
            this.#throwIfStopped();
            this.#emitConnectionStatus(true);
        } catch (error) {
            if (this.#stopped || this.#isCancellationError(error)) {
                return;
            }

            this.#cleanupConnection();
            this._logError('Failed to initialize device', error);
            this.#emitConnectionStatus(false, error);
        }

        // The health check is the single reconnection engine (exponential
        // backoff). It remains active across internal client rebuilds.
        if (!this.#stopped) {
            this.#startHealthCheck();
        }
    }

    disconnect() {
        if (this.#stopped) {
            return;
        }

        this.#stopped = true;
        this._logMessage('INFO', 'Disconnecting from device');

        // Device-facing listeners are removed before transport teardown so no
        // in-flight continuation can update a replaced/deleted Homey device.
        this.removeAllListeners();

        if (this.#healthCheckIntervalId) {
            this._clearInterval(this.#healthCheckIntervalId);
            this.#healthCheckIntervalId = null;
        }

        this.#cleanupConnection();
        this.#isReconnecting = false;
        this.#backoffState = null;
        this.#errorTimestamps = [];
    }

    #cleanupConnection() {
        const socket = this.#socket;
        const pendingConnect = this.#pendingConnect;

        // Invalidate the transport before touching it. All async continuations
        // compare this token and the captured client/socket before doing work.
        this.#connectionGeneration += 1;

        if (this.#pollIntervalId) {
            this._clearInterval(this.#pollIntervalId);
            this.#pollIntervalId = null;
        }

        this.#socket = null;
        this.#modbusClient = null;
        this.#systemModbusClient = null;
        this.#isPolling = false;
        this.#infoRegistriesRead = false;
        this.#failedRegisters.clear();
        this.#coalesceBlocklist.clear();
        this.#connectionHasAnswered = false;
        this.#slowPollReported = false;
        this.#readPlanLogged.clear();
        this.#connectedAt = null;

        if (pendingConnect && pendingConnect.socket === socket) {
            pendingConnect.cancel();
        }

        if (socket) {
            // Keep socket listeners attached through destroy so jsmodbus sees
            // close and rejects/clears its active and queued requests. Our own
            // socket callbacks are generation guarded against stale effects.
            if (!socket.destroyed) {
                socket.destroy();
            }
        }
    }

    async #initListenersAndConnect() {
        this.#throwIfStopped();

        const generation = this.#connectionGeneration + 1;
        const socket = new net.Socket();
        const modbusClient = new Modbus.client.TCP(
            socket,
            this.options.modbus_unitId,
            this.#connectionTimeout
        );
        let systemModbusClient = null;

        // If this client also has system registries, create the system client.
        if (deviceType.getSystemRegistries(this.deviceRegistryType)?.length) {
            systemModbusClient = new Modbus.client.TCP(
                socket,
                SYSTEM_UNIT_ID,
                this.#connectionTimeout
            );
        }

        this.#connectionGeneration = generation;
        this.#socket = socket;
        this.#modbusClient = modbusClient;
        this.#systemModbusClient = systemModbusClient;

        await new Promise((resolve, reject) => {
            const pendingConnect = {
                socket,
                generation,
                settled: false,
                cancel: null
            };

            const settle = (error) => {
                if (pendingConnect.settled) {
                    return;
                }

                pendingConnect.settled = true;
                if (this.#pendingConnect === pendingConnect) {
                    this.#pendingConnect = null;
                }

                if (error) {
                    reject(error);
                } else {
                    resolve();
                }
            };

            pendingConnect.cancel = () => settle(this.#createCancellationError());
            this.#pendingConnect = pendingConnect;

            const onError = (error) => {
                if (!this.#isCurrentConnection(socket, generation)) {
                    return;
                }
                settle(this.#describeConnectError(error));
            };

            const onClose = () => {
                if (!this.#isCurrentConnection(socket, generation)) {
                    return;
                }

                // The connect failure this produces is reported by the caller,
                // so this is only the detail behind it.
                this._logMessage('DEBUG', 'Socket closed before connection completed');
                const error = new Error('Socket closed before connection completed');
                error.code = 'ECONNRESET';
                settle(this.#describeConnectError(error));
            };

            const onTimeout = () => {
                if (!this.#isCurrentConnection(socket, generation) || pendingConnect.settled) {
                    return;
                }

                const error = new Error('Socket connection timed out');
                error.code = 'ETIMEDOUT';
                settle(this.#describeConnectError(error));
                socket.destroy();
            };

            socket.on('error', onError);
            socket.on('close', onClose);
            socket.on('timeout', onTimeout);

            try {
                socket.connect({
                    host: this.options.host,
                    port: this.options.port,
                    timeout: this.#connectionTimeout
                }, () => {
                    if (pendingConnect.settled) {
                        return;
                    }
                    if (!this.#isCurrentConnection(socket, generation)) {
                        settle(this.#createCancellationError());
                        return;
                    }

                    this._logMessage('INFO', 'Socket connected');
                    this.#connectedAt = Date.now();
                    this.#backoffState = null;
                    this.#pollIntervalId = this._setInterval(() => {
                        if (this.#isCurrentConnection(socket, generation)) {
                            this.#pollDevice(generation);
                        }
                    }, this.options.refreshInterval * 1000);
                    settle();
                });
            } catch (error) {
                settle(error);
            }
        });

        if (!this.#isCurrentConnection(socket, generation)) {
            throw this.#createCancellationError();
        }
    }

    async #pollDevice(generation) {
        if (this.#stopped || generation !== this.#connectionGeneration) {
            return;
        }

        // Guard against overlapping polls. A single poll can take up to
        // (registers × per-request timeout) on a slow/unresponsive device,
        // which may exceed refreshInterval.
        if (this.#isPolling) {
            // A device slow enough to overrun its refresh interval does this on
            // every cycle, so report it once per connection at INFO (it points
            // at a refreshInterval/timeout that needs raising) and leave the
            // repeats to DEBUG.
            if (this.#slowPollReported) {
                this._logMessage('DEBUG', 'Previous poll still in progress, skipping this cycle');
            } else {
                this.#slowPollReported = true;
                this._logMessage('INFO', 'Previous poll still in progress, skipping this cycle'
                    + ` - a full sweep is taking longer than the ${this.options.refreshInterval}s refresh interval`);
            }
            return;
        }

        this.#isPolling = generation;
        try {
            await this.#readInfoRegistries(generation);
            if (this.#stopped || generation !== this.#connectionGeneration) {
                return;
            }
            await this.#readDeviceRegistries(generation);
        } finally {
            if (this.#isPolling === generation) {
                this.#isPolling = false;
            }
        }
    }

    /**
     * Read a set of registries, coalescing contiguous ones into single range
     * reads to cut round-trips (lower latency and desync risk). The result is a
     * map of { registryKey: Buffer|null } which deviceType.decodeValues consumes
     * directly (paired by name, not by array position).
     */
    async #readRegistrySet(registries, client, label, generation) {
        const buffers = {};
        // Registers the device has proven it will not answer are not requested at
        // all. They are simply absent from the buffer map, which decodeValues
        // treats as "not known" - the same handling as a failed read, so no
        // capability is written a placeholder value.
        const requested = this.#skippedRegisters.size > 0
            ? registries.filter(reg => !this.#skippedRegisters.has(reg.registryId))
            : registries;
        const runs = deviceType.groupRegistersIntoRuns(requested, {
            maxGap: MODBUS_MAX_COALESCE_GAP,
            maxRun: MODBUS_MAX_COALESCE_RUN
        });

        this.#logReadPlan(label, runs);

        for (const run of runs) {
            this.#assertActiveClient(client, generation);
            const runKey = `${run.start}:${run.count}`;

            // A lone register, or a run the device previously rejected as a
            // range or left unanswered, is read one register at a time.
            if (run.registers.length === 1
                || this.#coalesceBlocklist.has(runKey)
                || this.#demotedRuns.has(runKey)) {
                for (const reg of run.registers) {
                    this.#assertActiveClient(client, generation);
                    buffers[reg.key] = await this.#readSingleRegister(reg, client, label, generation);
                }
                continue;
            }

            try {
                const result = await client.readHoldingRegisters(run.start, run.count);
                this.#assertActiveClient(client, generation);
                this.#noteSuccessfulRead(`run:${runKey}`);
                const runBuffer = getRegisterBuffer(result);
                const slices = deviceType.sliceRunBuffer(runBuffer, run);
                for (const reg of run.registers) {
                    buffers[reg.key] = slices[reg.key];
                    if (this.#failedRegisters.delete(reg.registryId)) {
                        this._logMessage('INFO', `${label} register ${reg.registryId} (${reg.comment}) recovered`);
                    }
                }
            } catch (runErr) {
                if (this.#isCancellationError(runErr)) {
                    throw runErr;
                }
                if (!this.#isActiveClient(client, generation)) {
                    throw this.#createCancellationError();
                }
                // Recorded before the rethrow below, which is what makes the next
                // connection read this range differently instead of repeating it.
                this.#recordSilentRead(`run:${runKey}`, runErr, RUN_STRIKES_BEFORE_DEMOTING, () => {
                    this.#demotedRuns.add(runKey);
                    this._logMessage('INFO', `${label} range ${run.start}+${run.count} went unanswered`
                        + ` - reading its registers individually from now on`);
                });
                if (this.#shouldRebuildModbus(runErr)) {
                    throw runErr;
                }

                // Range read unsupported/failed — remember it and fall back to
                // per-register reads so a single unmapped register cannot blank
                // the whole group.
                if (!this.#coalesceBlocklist.has(runKey)) {
                    this.#coalesceBlocklist.add(runKey);
                    this._logMessage('INFO', `${label} coalesced read ${run.start}+${run.count} failed, using per-register reads`);
                }
                for (const reg of run.registers) {
                    this.#assertActiveClient(client, generation);
                    buffers[reg.key] = await this.#readSingleRegister(reg, client, label, generation);
                }
            }
        }

        this.#assertActiveClient(client, generation);
        return buffers;
    }

    /**
     * Record how a registry set is being fetched: which address ranges are
     * requested in one call and which registers each range carries. Logged once
     * per connection per set, since the grouping is derived purely from the
     * register definitions and so does not change within a session. (A range the
     * device rejects is reported separately, at INFO, when it is blocklisted.)
     *
     * This is the counterpart to #logDecodedValues: together they show what was
     * asked for and what came back, which is what distinguishes "the device does
     * not implement this register" from "we never asked for it".
     */
    #logReadPlan(label, runs) {
        if (!this._isDebugEnabled() || runs.length === 0 || this.#readPlanLogged.has(label)) {
            return;
        }

        this.#readPlanLogged.add(label);
        const plan = runs
            .map(run => `${run.start}+${run.count} [${run.registers.map(reg => reg.key).join(' ')}]`)
            .join(', ');
        this._logMessage('DEBUG', `${label} read plan: ${plan}`);
    }

    /**
     * Record the decoded result of a sweep, and name the registers that produced
     * no value at all.
     *
     * The distinction matters: a register that read successfully as zero appears
     * in the values object as 0, while one that failed or is unimplemented is
     * absent. Without this, a capability sitting at 0 is indistinguishable from
     * a capability that is never being written.
     *
     * The INFO set is logged at INFO, not DEBUG. It is read once per connection
     * and is the device describing itself - model, serial, firmware, and the
     * configuration that decides which capabilities exist. Firmware in
     * particular is what makes an absent register answerable, because register
     * availability tracks the protocol revision the firmware implements. Having
     * that in every diagnostic report, not just the ones where the user thought
     * to enable detailed logging first, is worth one line per session.
     *
     * @param {string} label
     * @param {Array} registries - the registries this sweep asked for
     * @param {object} values - the decoded result
     * @param {{level?: string, durationMs?: number}} [options]
     */
    #logDecodedValues(label, registries, values, { level = 'DEBUG', durationMs } = {}) {
        if (registries.length === 0 || (level === 'DEBUG' && !this._isDebugEnabled())) {
            return;
        }

        // Sweep duration is the cheapest answer to "is this device slow?", which
        // is what drives the refreshInterval/timeout advice behind most
        // timeout and drop-out reports.
        const timing = Number.isFinite(durationMs) ? ` (${durationMs}ms)` : '';
        this._logMessage(level, `${label} values${timing}:`, values);

        const missing = registries
            .filter(reg => values[reg.key] === undefined)
            .map(reg => `${reg.key}@${reg.registryId}`);

        if (missing.length > 0) {
            this._logMessage(level, `${label} registers with no value: ${missing.join(', ')}`);
        }
    }

    /**
     * Read a single register, tolerating a soft failure: returns its buffer, or
     * null while flagging (and logging once) the register as failed until it
     * recovers. A connection-level error is rethrown.
     */
    async #readSingleRegister(registry, client, label, generation) {
        this.#assertActiveClient(client, generation);

        try {
            const result = await client.readHoldingRegisters(registry.registryId, registry.count);
            this.#assertActiveClient(client, generation);
            this.#noteSuccessfulRead(`reg:${registry.registryId}`);
            const buffer = getRegisterBuffer(result);
            if (this.#failedRegisters.delete(registry.registryId)) {
                this._logMessage('INFO', `${label} register ${registry.registryId} (${registry.comment}) recovered`);
            }
            return buffer;
        } catch (regErr) {
            if (this.#isCancellationError(regErr)) {
                throw regErr;
            }
            if (!this.#isActiveClient(client, generation)) {
                throw this.#createCancellationError();
            }
            this.#recordSilentRead(`reg:${registry.registryId}`, regErr, REGISTER_STRIKES_BEFORE_SKIPPING, () => {
                this.#skippedRegisters.set(registry.registryId, registry.comment);
                this._logMessage('INFO', `Register ${registry.registryId} (${registry.comment}) went unanswered on`
                    + ` ${REGISTER_STRIKES_BEFORE_SKIPPING} separate connections while the device was responding`
                    + ` - no longer reading it`);
                this.#reportSkippedRegisters();
            });
            if (this.#shouldRebuildModbus(regErr)) {
                throw regErr;
            }
            if (!this.#failedRegisters.has(registry.registryId)) {
                this.#failedRegisters.set(registry.registryId, registry.comment);
                this._logMessage('INFO', `Register ${registry.registryId} (${registry.comment}) read failed, skipping`);
            }
            return null;
        }
    }

    /**
     * A read came back. Two things follow from that: this connection is
     * demonstrably answering us (which is what licenses attributing a later
     * silence to the read rather than to the transport), and whatever suspicion
     * this particular read had accumulated is void.
     */
    #noteSuccessfulRead(strikeKey) {
        this.#connectionHasAnswered = true;
        this.#timeoutStrikes.delete(strikeKey);
    }

    /**
     * Count a read the device answered with silence, and act once there is enough
     * evidence that the read itself is the problem.
     *
     * Only silence counts. An exception response means the device parsed the
     * request and declined it, which the existing per-register fallback already
     * handles gracefully and which does not force a reconnect. Silence is the
     * case with no graceful handling: jsmodbus cannot tell a lost request from a
     * slow one, so the transport has to be rebuilt, and without this the
     * rebuilt connection just repeats the same read.
     *
     * Strikes are only counted while this connection has already had a
     * successful read. That is the whole safeguard against blacklisting healthy
     * registers: an inverter that is rebooting, or that has run out of Modbus TCP
     * connections, accepts the socket and then answers nothing at all, so nothing
     * succeeds, so nothing accrues strikes. The cost of that safeguard is that a
     * read which is the first of a sweep can never be learned.
     */
    #recordSilentRead(strikeKey, err, threshold, onThresholdReached) {
        if (!this.#isSilentReadError(err) || !this.#connectionHasAnswered) {
            return;
        }

        const strikes = (this.#timeoutStrikes.get(strikeKey) || 0) + 1;
        this.#timeoutStrikes.set(strikeKey, strikes);

        if (strikes < threshold) {
            this._logMessage('INFO', `${strikeKey} went unanswered (${strikes}/${threshold})`
                + ' while the device was otherwise responding');
            return;
        }

        onThresholdReached();
    }

    #isSilentReadError(err) {
        return typeof err?.err === 'string' && err.err.toLowerCase() === 'timeout';
    }

    /**
     * Hand the skipped-register list to the device layer, which surfaces it as a
     * read-only setting. Only on change, so this can be called from the poll loop.
     *
     * An empty list is reported too, and deliberately: "nothing is being skipped"
     * and "we have not got far enough to know" are different answers, and the
     * device setting starts out unable to tell them apart.
     */
    #reportSkippedRegisters() {
        if (this.#stopped) {
            return;
        }

        const registryIds = [...this.#skippedRegisters.keys()].sort((a, b) => a - b);
        const listKey = registryIds.join(',');
        if (listKey === this.#reportedSkipList) {
            return;
        }
        this.#reportedSkipList = listKey;

        try {
            if (this.listenerCount('diagnostics') > 0) {
                this.emit('diagnostics', {
                    skippedRegisters: registryIds,
                    maxReported: MAX_REPORTED_SKIPPED_REGISTERS
                });
            }
        } catch (_) {
            // Never let diagnostics surfacing break the poll/reconnect loop.
        }
    }

    async #readSystemRegistries(generation) {
        const systemRegistries = deviceType.getSystemRegistries(this.deviceRegistryType);

        if (!systemRegistries?.length) {
            // A property of the device type, not of this sweep, so it is stated
            // once per connection alongside the other read plans rather than on
            // every poll.
            if (this._isDebugEnabled() && !this.#readPlanLogged.has('System')) {
                this.#readPlanLogged.add('System');
                this._logMessage('DEBUG', 'System read plan: none (this device type has no plant-level registers)');
            }
            return null;
        }

        const client = this.#systemModbusClient;
        if (!this.#isActiveClient(client, generation)) {
            throw this.#createCancellationError();
        }

        if (!this.#isConnected(client)) {
            const error = new Error('System Modbus client is not connected');
            error.err = 'Offline';
            throw error;
        }

        try {
            const systemReadings = await this.#readRegistrySet(systemRegistries, client, 'System', generation);
            this.#assertActiveClient(client, generation);
            const decoded = deviceType.decodeValues(this.deviceRegistryType, systemReadings);
            this.#logDecodedValues('System', systemRegistries, decoded);
            return decoded;
        } catch (err) {
            if (this.#isCancellationError(err) || this.#shouldRebuildModbus(err)) {
                // Poisoning errors must reach the device sweep so its already
                // decoded device portion is discarded rather than emitted.
                throw err;
            }
            await this.#handleModbusError('System registry read failed', err, { client, generation });
            return null;
        }
    }

    async #readDeviceRegistries(generation) {
        const client = this.#modbusClient;
        if (!this.#isActiveClient(client, generation)) {
            return;
        }

        if (!this.#isConnected(client)) {
            // Repeats every poll for as long as the device is offline. The
            // disconnect itself is already reported, so this is detail only.
            this._logMessage('DEBUG', 'Skipping device registry read — device modbus client not connected');
            return;
        }

        try {
            const readingRegistries = deviceType.getReadingRegistries(this.deviceRegistryType);
            const startedAt = Date.now();
            const deviceReadings = await this.#readRegistrySet(readingRegistries, client, 'Device', generation);
            const durationMs = Date.now() - startedAt;
            this.#assertActiveClient(client, generation);

            const processedReadings = deviceType.decodeValues(this.deviceRegistryType, deviceReadings);
            this.#logDecodedValues('Device', readingRegistries, processedReadings, { durationMs });

            const systemReadings = await this.#readSystemRegistries(generation);
            this.#assertActiveClient(client, generation);

            if (systemReadings) {
                Object.assign(processedReadings, systemReadings);
            }

            if (Object.keys(processedReadings).length === 0) {
                return;
            }

            // A completed sweep is the point at which an empty skip list becomes
            // a real answer rather than an absence of one.
            this.#reportSkippedRegisters();
            this.emit('readings', processedReadings);
        } catch (err) {
            if (this.#isCancellationError(err)
                || this.#stopped
                || generation !== this.#connectionGeneration) {
                return;
            }
            await this.#handleModbusError('Device registry read failed', err, { generation });
        }
    }

    async #readInfoRegistries(generation) {
        if (this.#infoRegistriesRead) {
            return;
        }

        // A device type with no INFO registers (the AC charger's register table
        // has no model/serial/firmware) has nothing to read, so retire the step
        // instead of re-entering it on every poll.
        if (!deviceType.getInfoRegistries(this.deviceRegistryType)?.length) {
            this.#infoRegistriesRead = true;
            return;
        }

        const client = this.#modbusClient;
        if (!this.#isActiveClient(client, generation)) {
            return;
        }

        if (!this.#isConnected(client)) {
            // Repeats every poll for as long as the device is offline. The
            // disconnect itself is already reported, so this is detail only.
            this._logMessage('DEBUG', 'Skipping info registry read — device modbus client not connected');
            return;
        }

        try {
            const infoRegistries = deviceType.getInfoRegistries(this.deviceRegistryType);
            const readings = await this.#readRegistrySet(infoRegistries, client, 'Info', generation);
            this.#assertActiveClient(client, generation);
            const processedInfo = deviceType.decodeValues(this.deviceRegistryType, readings);
            this.#logDecodedValues('Info', infoRegistries, processedInfo, { level: 'INFO' });

            if (Object.keys(processedInfo).length === 0) {
                return;
            }

            this.emit('properties', processedInfo);
            this.#infoRegistriesRead = true;
        } catch (err) {
            if (this.#isCancellationError(err)
                || this.#stopped
                || generation !== this.#connectionGeneration) {
                return;
            }
            await this.#handleModbusError('Info registry read failed', err, { client, generation });
        }
    }

    getModbusClient(modbus_unitId) {
        if (this.#stopped) {
            return null;
        }
        if (modbus_unitId === SYSTEM_UNIT_ID) {
            return this.#systemModbusClient;
        }
        return this.#modbusClient;
    }

    /**
     * Write holding registers with the same resilience as the read path.
     *
     * @param {number} registryId - the starting holding-register address
     * @param {Buffer} buffer - the register payload to write
     * @param {number} [modbus_unitId] - unit id override (defaults to the device client)
     * @returns {Promise<true>} resolves true on success
     */
    async writeRegisters(registryId, buffer, modbus_unitId) {
        const generation = this.#connectionGeneration;
        const client = this.getModbusClient(modbus_unitId);

        if (!this.#isConnected(client)) {
            throw new Error(`Cannot write to register ${registryId}: Modbus client not connected`);
        }

        try {
            await client.writeMultipleRegisters(registryId, buffer);
            this.#assertActiveClient(client, generation);
            return true;
        } catch (err) {
            if (this.#isCancellationError(err) || !this.#isActiveClient(client, generation)) {
                throw this.#createCancellationError();
            }
            if (this.#shouldRebuildModbus(err)) {
                await this.#handleModbusError(`Write to register ${registryId} failed`, err, { client, generation });
            }
            throw err;
        }
    }

    #startHealthCheck() {
        if (this.#stopped || this.#healthCheckIntervalId) {
            return;
        }

        this.#healthCheckIntervalId = this._setInterval(async () => {
            if (this.#stopped) {
                return;
            }

            // Check if socket is healthy. A healthy socket is the normal case
            // and is not logged: three "nothing is wrong" lines a minute would
            // crowd out the readings in a debug capture, and a socket that is
            // up while reads fail is already visible from the read failures.
            if (this.#socket && !this.#socket.destroyed && this.#socket.readable && this.#socket.writable) {
                return;
            }

            // Both of the following repeat every health check cycle (20s) for as
            // long as a reconnect is pending, and neither is a new fact: the
            // reconnect attempt and its backoff are already reported once each.
            if (this.#isReconnecting) {
                this._logMessage('DEBUG', 'Reconnect already in progress, skipping health check cycle');
                return;
            }

            const backoffState = this.#backoffState || { attempts: 0, nextRetryTime: 0 };
            const now = Date.now();

            if (now < backoffState.nextRetryTime) {
                this._logMessage('DEBUG', `Skipping reconnect, next attempt in ${(backoffState.nextRetryTime - now) / 1000}s`);
                return;
            }

            // Recovering from a dropped socket is expected behaviour, not a
            // fault, so it does not belong in the error log. The reconnect
            // outcome below is what actually matters, and #rebuildModbusClients
            // logs the attempt itself.
            const success = await this.#rebuildModbusClients('socket unhealthy');

            if (this.#stopped) {
                return;
            }

            if (success) {
                this._logMessage('INFO', 'Reconnected successfully');
                this.#backoffState = null;
            } else {
                const attempts = backoffState.attempts + 1;
                const baseDelay = 10_000; // 10 seconds
                const maxDelay = 600_000; // 10 minutes max
                const delay = Math.min(Math.pow(2, attempts) * baseDelay, maxDelay);
                const nextRetryTime = Date.now() + delay;

                this._logMessage('INFO', `Reconnect failed (attempt ${attempts}), retrying in ${delay / 1000}s`);
                this.#backoffState = { attempts, nextRetryTime };
            }
        }, 20_000); // Run every 20s
    }

    async #handleModbusError(context, err, { client = null, generation = null } = {}) {
        if (this.#stopped
            || this.#isCancellationError(err)
            || (generation !== null && generation !== this.#connectionGeneration)
            || (client && !this.#isActiveClient(client, generation))) {
            return;
        }

        this._logError(`${context}:`, err);

        // Surface to the device (populates the "last error" debug setting) and
        // feed the sustained-failure telemetry window.
        this.#emitError(context, err);
        this.#reportErrorTelemetry(context, err);

        if (this.#shouldRebuildModbus(err) && !this.#stopped) {
            await this.#rebuildModbusClients(context);
        }
    }

    // Surface an error to the Homey device via the 'error' event. Guarded by
    // listenerCount so it never throws when no listener is attached.
    #emitError(context, err) {
        if (this.#stopped) {
            return;
        }

        try {
            if (this.listenerCount('error') > 0) {
                const message = utilFunctions.formatError(err);
                this.emit('error', new Error(`${context}: ${message}`));
            }
        } catch (_) {
            // Never let error surfacing break the poll/reconnect loop.
        }
    }

    // Report connection state to the device. Guarded so a listener error can
    // never break the poll/reconnect loop.
    #emitConnectionStatus(connected, error) {
        if (this.#stopped) {
            return;
        }

        try {
            if (this.listenerCount('connectionStatus') > 0) {
                this.emit('connectionStatus', { connected, error });
            }
        } catch (_) {
            // Never let availability surfacing break the poll/reconnect loop.
        }
    }

    // Records a serious error and, when errors arrive in bursts (a sustained
    // failure rather than an occasional glitch), reports one event per device
    // per interval so we can see which device types/settings are affected.
    #reportErrorTelemetry(context, err) {
        if (this.#stopped) {
            return;
        }

        try {
            const now = Date.now();
            const windowMs = 10 * 60 * 1000; // 10 minutes
            const threshold = 10;            // errors within the window => sustained problem

            this.#errorCount += 1;
            this.#errorTimestamps.push(now);
            this.#errorTimestamps = this.#errorTimestamps.filter(t => now - t <= windowMs);

            if (this.#errorTimestamps.length < threshold) {
                return;
            }

            const errorsInWindow = this.#errorTimestamps.length;
            // Start a fresh window. Without this the window stays above the
            // threshold for as long as errors keep arriving, so every single
            // error re-attempted a report; now each attempt represents another
            // full burst. The cumulative count below carries the "how bad is
            // it" signal instead.
            this.#errorTimestamps = [];

            const device = this.options?.device;
            let driverId = 'unknown';
            let deviceId = this.deviceTypeName;
            let homeyVersion = 'unknown';
            try { driverId = device?.driver?.id || 'unknown'; } catch (_) { /* ignore */ }
            try { deviceId = device?.getData?.().id || this.deviceTypeName; } catch (_) { /* ignore */ }
            try { homeyVersion = device?.homey?.version || 'unknown'; } catch (_) { /* ignore */ }

            logger.report(
                `modbus-sustained-failure:${driverId}:${deviceId}`,
                'Sustained Modbus failures',
                {
                    level: 'warning',
                    tags: {
                        deviceType: this.deviceTypeName,
                        driver: driverId,
                        homeyVersion,
                        refreshInterval: String(this.options?.refreshInterval),
                        timeout: String(this.options?.timeout)
                    },
                    extra: {
                        context,
                        errorsInWindow,
                        totalErrorsThisSession: this.#errorCount,
                        windowMinutes: 10,
                        refreshInterval: this.options?.refreshInterval,
                        timeoutSetting: this.options?.timeout,
                        modbusUnitId: this.options?.modbus_unitId,
                        lastError: utilFunctions.formatError(err)
                    }
                }
            );
        } catch (_) {
            // Telemetry must never affect device operation.
        }
    }

    #shouldRebuildModbus(err) {
        if (!err) {
            return false;
        }

        const modbusError = typeof err.err === 'string' ? err.err.toLowerCase() : '';
        if (['offline', 'outofsync', 'protocol', 'timeout'].includes(modbusError)) {
            return true;
        }

        const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
        if (message.includes('fc and response fc does not match')) {
            return true;
        }

        const code = typeof err.code === 'string' ? err.code.toUpperCase() : '';
        return ['ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(code);
    }

    async #rebuildModbusClients(reason) {
        if (this.#stopped) {
            return false;
        }

        if (this.#isReconnecting) {
            this._logMessage('DEBUG', `Reconnect already in progress (${reason})`);
            return false;
        }

        this.#isReconnecting = true;
        this.#reconnectCount += 1;
        let success = false;

        // Poisoned/failed transports are unavailable until a fresh connection
        // succeeds. Emit once per rebuild attempt; the failure path below does
        // not repeat the transition.
        this.#emitConnectionStatus(false);
        this._logMessage('INFO', `Rebuilding Modbus clients (${reason})`);

        try {
            // Internal rebuilding invalidates only the transport generation; it
            // does not permanently stop this Base or restart its health timer.
            this.#cleanupConnection();
            this.#throwIfStopped();
            await this.#initListenersAndConnect();
            this.#throwIfStopped();
            success = true;
            this._logMessage('INFO', 'Modbus clients rebuilt successfully');
            this.#emitConnectionStatus(true);
        } catch (error) {
            if (!this.#stopped && !this.#isCancellationError(error)) {
                this.#cleanupConnection();
                this._logError('Failed to rebuild Modbus clients', error);
                // A failed reconnect does not produce read errors, so feed it
                // into the same telemetry window to catch sustained outages.
                this.#emitError(`Reconnect failed (${reason})`, error);
                this.#reportErrorTelemetry(`Reconnect failed (${reason})`, error);
            }
        } finally {
            this.#isReconnecting = false;
        }

        return success;
    }

    /**
     * Restate a connect-phase socket error in terms of what the user can act on.
     *
     * A raw Node socket error reads "connect ECONNREFUSED 192.168.1.5:502", which
     * says what happened but not what it means for this device. This is the only
     * error a user sees when a device never comes up, and it lands in the
     * "last error" setting, so it should name the difference between nothing
     * listening on the port and nothing answering at that address.
     *
     * `code` is preserved because #shouldRebuildModbus classifies on it.
     */
    #describeConnectError(error) {
        if (!error || this.#isCancellationError(error)) {
            return error;
        }

        const described = new Error(formatSocketError(error, this.options.host, this.options.port));
        if (error.code) {
            described.code = error.code;
        }
        return described;
    }

    #isCurrentConnection(socket, generation) {
        return !this.#stopped
            && generation === this.#connectionGeneration
            && socket === this.#socket;
    }

    #isActiveClient(client, generation) {
        return !this.#stopped
            && generation === this.#connectionGeneration
            && client !== null
            && (client === this.#modbusClient || client === this.#systemModbusClient);
    }

    #assertActiveClient(client, generation) {
        if (!this.#isActiveClient(client, generation)) {
            throw this.#createCancellationError();
        }
    }

    #throwIfStopped() {
        if (this.#stopped) {
            throw this.#createCancellationError();
        }
    }

    #createCancellationError() {
        const error = new Error('Base session is no longer active');
        error.code = SESSION_CANCELLED_CODE;
        return error;
    }

    #isCancellationError(error) {
        return error?.code === SESSION_CANCELLED_CODE;
    }

    #isConnected(client) {
        return client
            && client._socket
            && client._socket.readable
            && client._socket.writable
            && !client._socket.destroyed
            && !client._socket.connecting;
    }

    async #validateOptions(options) {
        if (!options) {
            throw new Error('Missing input options!');
        }

        if (options.modbus_unitId) {
            // Make sure unitId exists and is a number.
            options.modbus_unitId = Number(options.modbus_unitId);
        } else {
            throw new Error('modbus_unitId is mandatory input');
        }

        if (options.host && !utilFunctions.validateIPaddress(options.host)) {
            throw new Error(`Invalid IP address '${options.host}'`);
        }

        // Reachability is deliberately not pre-checked here. #initListenersAndConnect
        // opens the real socket immediately afterwards, so a separate probe only
        // added a second connection per initialize - and it judged reachability on
        // a fixed 1s budget, stricter than the user's configured timeout. Every
        // device in the app connects at once at startup, which is exactly when an
        // inverter is slowest to accept, so the probe could fail a connection that
        // the real attempt would have completed. The connect error is now formatted
        // for the same detail the probe's message carried.
        return options;
    }
}

module.exports = Base;
