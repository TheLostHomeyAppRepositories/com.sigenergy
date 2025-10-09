'use strict';
const { BatteryRegistry } = require('../modbus/registry/battery.js');
const Base = require('../base.js');

class Battery extends Base {
    constructor(options) {
        super(BatteryRegistry, options);
    }

}

module.exports = Battery;