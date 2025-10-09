'use strict';

const BaseDriver = require('../baseDriver.js');
const { EnergyRegistry } = require('../../lib/modbus/registry/energy.js');

class EnergyDriver extends BaseDriver {

    async onPair(session) {
        return await super.pair(EnergyRegistry.power, 'Energy Meter', session, true);
    }

}
module.exports = EnergyDriver;