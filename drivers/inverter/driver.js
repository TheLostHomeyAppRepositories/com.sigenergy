'use strict';

const BaseDriver = require('../baseDriver.js');
const { InverterRegistry } = require('../../lib/modbus/registry/inverter.js');

class InverterDriver extends BaseDriver {

    async onPair(session) {
        return await super.pair(InverterRegistry.serial, 'Inverter', session);
    }
}
module.exports = InverterDriver;
