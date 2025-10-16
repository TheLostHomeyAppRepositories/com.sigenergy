'use strict';
const { PlantRegistry } = require('../modbus/registry/plant.js');
const Base = require('../base.js');

class Plant extends Base {
    constructor(options) {
        super(PlantRegistry, options);
    }
}

module.exports = Plant;