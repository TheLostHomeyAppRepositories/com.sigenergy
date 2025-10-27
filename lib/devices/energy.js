'use strict';
const { EnergyRegistry } = require('../modbus/registry/energy.js');
const Base = require('../base.js');
const utilFunctions = require('../util.js');

class Energy extends Base {
    constructor(options) {
        super(EnergyRegistry, options);
    }

    setMaxExportLimitation(limit) {
        return this.getModbusClient().writeMultipleRegisters(40038, utilFunctions.createBuffer32(limit, 1000))
            .then(() => true);
    }

    setMaxImportLimitation(limit) {
        return this.getModbusClient().writeMultipleRegisters(40040, utilFunctions.createBuffer32(limit, 1000))
            .then(() => true);
    }
}
module.exports = Energy;