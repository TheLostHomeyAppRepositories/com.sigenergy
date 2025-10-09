'use strict';

const BaseDriver = require('../baseDriver.js');
const { EvACChargerRegistry } = require('../../lib/modbus/registry/evACCharger.js');

class EvACChargerDriver extends BaseDriver {

    async onPair(session) {
        return await super.pair(EvACChargerRegistry.status, 'EV AC Charger', session, true);
    }

}
module.exports = EvACChargerDriver;