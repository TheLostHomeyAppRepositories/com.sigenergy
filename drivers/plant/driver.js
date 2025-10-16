'use strict';

const BaseDriver = require('../baseDriver.js');
const { PlantRegistry } = require('../../lib/modbus/registry/plant.js');

class PlantDriver extends BaseDriver {

    async onPair(session) {
        return await super.pair(PlantRegistry.gridPower, 'Plant', session, true);
    }
}
module.exports = PlantDriver;
