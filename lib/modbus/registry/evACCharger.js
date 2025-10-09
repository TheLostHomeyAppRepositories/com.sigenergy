'use strict';

const { ModbusRegistry, type, setting } = require('../modbusRegistry.js');

const EvACChargerRegistry = Object.freeze({
    name: 'EvACCharger',

    status: new ModbusRegistry(setting.READING, 32000, 1, type.uint16_1, 'Status'),
    totalChargeEnergy: new ModbusRegistry(setting.READING, 32001, 2, type.uint32_100, 'Total charged energy'),
    power: new ModbusRegistry(setting.READING, 32003, 2, type.int32_1000, 'Charging power')

});

module.exports = {
    EvACChargerRegistry
}