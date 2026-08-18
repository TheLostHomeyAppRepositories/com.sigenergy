'use strict';

const EventEmitter = require('events');

class HomeyEventEmitter extends EventEmitter {
    constructor() {
        super();
    }

    _sleep(time) {
        return new Promise((resolve) => this._setTimeout(resolve, time));
    }

    _setTimeout(func, ms) {
        if (this.options.device) {
            return this.options.device.homey.setTimeout(func, ms);
        } else {
            return setTimeout(func, ms);
        }
    }

    _setInterval(func, ms) {
        if (this.options.device) {
            return this.options.device.homey.setInterval(func, ms);
        } else {
            return setInterval(func, ms);
        }
    }

    _clearInterval(timer) {
        if (this.options.device) {
            this.options.device.homey.clearInterval(timer);
        } else {
            clearInterval(timer);
        }
    }

    /**
     * True when this device has debug logging switched on in its settings.
     *
     * Exposed so callers can skip building an expensive DEBUG message (string
     * concatenation, array scans) that would be thrown away anyway.
     */
    _isDebugEnabled() {
        return this.options?.debug === true;
    }

    /**
     * Log at one of two levels:
     *
     *   INFO  - a state transition worth having in every diagnostic report:
     *           connect, disconnect, reconnect, a register starting or stopping
     *           to fail, a setting change. Emitted once per transition, never
     *           once per poll, so the log stays readable over days of uptime.
     *   DEBUG - per-poll detail (read plan, decoded values, socket health).
     *           Only emitted while the device's "Detailed logging" setting is
     *           on, because at a 10s refresh this is thousands of lines a day.
     *
     * Failures use _logError instead, which always writes to the error log.
     */
    _logMessage(level, ...msg) {
        if (level === 'INFO' || this._isDebugEnabled()) {
            this.#log(...msg);
        }
    }

    _logError(...error) {
        if (this.options.device) {
            this.options.device.error(...error);
        } else {
            console.error(...error);
        }        
    }

    #log(...msg) {
        if (this.options.device) {
            this.options.device.log(...msg);
        } else {
            console.log(...msg);
        }
    }
}
module.exports = HomeyEventEmitter;
