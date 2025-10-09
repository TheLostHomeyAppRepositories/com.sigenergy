'use strict';

const BaseDriver = require('../baseDriver.js');
const { BatteryRegistry } = require('../../lib/modbus/registry/battery.js');

class BatteryDriver extends BaseDriver {

    async onPair(session) {
        return await super.pair(BatteryRegistry.serial, 'Battery', session);
    }

}
module.exports = BatteryDriver;
