'use strict';

const { ModbusRegistry, type, setting } = require('../modbusRegistry.js');

const BatteryRegistry = Object.freeze({
    name: 'Battery',

    serial: new ModbusRegistry(setting.INFO, 30515, 10, type.string, 'Serial'),
    capacity: new ModbusRegistry(setting.INFO, 30548, 2, type.uint32_100, 'Rated battery capacity'),

    power: new ModbusRegistry(setting.SYSTEM, 30037, 2, type.int32_1, 'Battery Power'),

    totalChargeEnergy: new ModbusRegistry(setting.READING, 30568, 4, type.uint64_100, 'Total charge energy'),
    totalDischargeEnergy: new ModbusRegistry(setting.READING, 30574, 4, type.uint64_100, 'Total discharge energy'),
    status: new ModbusRegistry(setting.READING, 30578, 1, type.uint16_1, 'Running state'),
    soc: new ModbusRegistry(setting.READING, 30601, 1, type.uint16_10, 'Battery SoC'),
    soh: new ModbusRegistry(setting.READING, 30602, 1, type.uint16_10, 'Battery SoH'),
    maxCellTemperature: new ModbusRegistry(setting.READING, 30620, 1, type.int16_10, 'Maximum cell temperature'),
    minCellTemperature: new ModbusRegistry(setting.READING, 30621, 1, type.int16_10, 'Minimum cell temperature'),
    // Cell voltages are not working for some reason
    // maxCellVoltage: new ModbusRegistry(setting.READING, 30622, 1, type.uint16_1000, 'Maximum cell voltage'),
    // minCellVoltage: new ModbusRegistry(setting.READING, 30623, 1, type.uint16_1000, 'Minimum cell voltage')
});

module.exports = {
    BatteryRegistry
}