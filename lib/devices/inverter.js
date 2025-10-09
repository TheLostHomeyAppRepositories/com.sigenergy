'use strict';
const { InverterRegistry } = require('../modbus/registry/inverter.js');
const Base = require('../base.js');

class Inverter extends Base {
    constructor(options) {
        super(InverterRegistry, options);
    }
}

module.exports = Inverter;