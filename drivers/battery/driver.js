'use strict';

const BaseDriver = require('../baseDriver.js');
const { BatteryRegistry } = require('../../lib/modbus/registry/battery.js');
const enums = require('../../lib/enums.js');

class BatteryDriver extends BaseDriver {

    async onInit() {
        this._registerFlows();
    }

    _registerFlows() {
        this.log('Registering flows');

        // Firmware changed, triggered automatically by Homey given namingstandard
        this._firmware_changed = this.homey.flow.getDeviceTriggerCard('firmware_changed');

    }

    async onPair(session) {
        return await super.pair(BatteryRegistry.serial, 'Battery', session);
    }

}
module.exports = BatteryDriver;
