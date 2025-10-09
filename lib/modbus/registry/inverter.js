'use strict';

const { ModbusRegistry, type, setting } = require('../modbusRegistry.js');

const InverterRegistry = Object.freeze({
    name: 'Inverter',

    serial: new ModbusRegistry(setting.INFO, 30515, 10, type.string, 'Serial'),
    mpptCount: new ModbusRegistry(setting.INFO, 31026, 1, type.uint16_1, 'MPPT count'),

    pv1Voltage: new ModbusRegistry(setting.READING, 31027, 1, type.int16_10, 'PV1 Voltage'),
    pv2Voltage: new ModbusRegistry(setting.READING, 31029, 1, type.int16_10, 'PV2 Voltage'),
    pv3Voltage: new ModbusRegistry(setting.READING, 31031, 1, type.int16_10, 'PV3 Voltage'),
    pv4Voltage: new ModbusRegistry(setting.READING, 31033, 1, type.int16_10, 'PV4 Voltage'),
    power: new ModbusRegistry(setting.READING, 31035, 2, type.int32_1, 'Power'),

    dailyYield: new ModbusRegistry(setting.READING, 31509, 2, type.uint32_100, 'Daily Yield'),
    totalYield: new ModbusRegistry(setting.READING, 31511, 2, type.uint32_100, 'Total Yield'),

});

module.exports = {
    InverterRegistry
}