'use strict';
const { EvACChargerRegistry } = require('../modbus/registry/evACCharger.js');
const Base = require('../base.js');
const utilFunctions = require('../util.js');

class EVACCharger extends Base {
    constructor(options) {
        super(EvACChargerRegistry, options);
    }

    // Register 42000 is inverted relative to the plant's Start/Stop:
    // 0 = start, 1 = stop (protocol V2.9, table 5-6).
    startCharging() {
        return this.writeRegisters(42000, utilFunctions.createBuffer(0, 1));
    }

    stopCharging() {
        return this.writeRegisters(42000, utilFunctions.createBuffer(1, 1));
    }
}

module.exports = EVACCharger;