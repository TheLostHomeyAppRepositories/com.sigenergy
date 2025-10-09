'use strict';
const { EnergyRegistry } = require('../modbus/registry/energy.js');
const Base = require('../base.js');

class Energy extends Base {
    constructor(options) {
        super(EnergyRegistry, options);
    }
}

module.exports = Energy;