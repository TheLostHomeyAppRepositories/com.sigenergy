'use strict';

const { ModbusRegistry, type, setting } = require('../modbusRegistry.js');

const InverterRegistry = Object.freeze({
    name: 'Inverter',

    serial: new ModbusRegistry(setting.INFO, 30515, 10, type.string, 'Serial'),

    power: new ModbusRegistry(setting.READING, 31035, 2, type.int32_1, 'Power'),

    dailyYield: new ModbusRegistry(setting.READING, 31509, 2, type.uint32_100, 'Daily Yield'),
    totalYield: new ModbusRegistry(setting.READING, 31511, 2, type.uint32_100, 'Total Yield'),

});

module.exports = {
    InverterRegistry
}