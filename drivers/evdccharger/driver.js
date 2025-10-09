'use strict';

const BaseDriver = require('../baseDriver.js');
const { EvDCChargerRegistry } = require('../../lib/modbus/registry/evDCCharger.js');

class EvDCChargerDriver extends BaseDriver {

    async onPair(session) {
        return await super.pair(EvDCChargerRegistry.serial, 'EV DC Charger', session);
    }

}
module.exports = EvDCChargerDriver;