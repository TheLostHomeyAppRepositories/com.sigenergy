'use strict';

const { ModbusRegistry, type, setting } = require('../modbusRegistry.js');

const EnergyRegistry = Object.freeze({
    name: 'Energy',

    // serial: new ModbusRegistry(setting.INFO, 2609, 7, type.string, 'Serial'),

    power: new ModbusRegistry(setting.READING, 30005, 2, type.int32_1, 'Power'),
    gridStatus: new ModbusRegistry(setting.SYSTEM, 30009, 1, type.uint16_1, 'Grid status'),
    powerL1: new ModbusRegistry(setting.READING, 30052, 2, type.int32_1, 'Power L1'),
    powerL2: new ModbusRegistry(setting.READING, 30054, 2, type.int32_1, 'Power L2'),
    powerL3: new ModbusRegistry(setting.READING, 30056, 2, type.int32_1, 'Power L3'),

    // voltageL1: new ModbusRegistry(setting.READING, 2616, 1, type.uint16_10, 'Voltage L1'),
    // currentL1: new ModbusRegistry(setting.READING, 2617, 1, type.int16_10, 'Current L1'),
    // voltageL2: new ModbusRegistry(setting.READING, 2618, 1, type.uint16_10, 'Voltage L2'),
    // currentL2: new ModbusRegistry(setting.READING, 2619, 1, type.int16_10, 'Current L2'),
    // voltageL3: new ModbusRegistry(setting.READING, 2620, 1, type.uint16_10, 'Voltage L3'),
    // currentL3: new ModbusRegistry(setting.READING, 2621, 1, type.int16_10, 'Current L3'),

    totalImportedEnergy: new ModbusRegistry(setting.READING, 30260, 4, type.uint64_100, 'Imported energy'),
    totalExportedEnergy: new ModbusRegistry(setting.READING, 30264, 4, type.uint64_100, 'Exported energy'),

    phaseControl: new ModbusRegistry(setting.READING, 40030, 1, type.uint16_1, 'Independent phase control'),
});

module.exports = {
    EnergyRegistry
}