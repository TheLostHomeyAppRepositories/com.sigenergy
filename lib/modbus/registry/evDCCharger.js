'use strict';

const { ModbusRegistry, type, setting } = require('../modbusRegistry.js');

const EvDCChargerRegistry = Object.freeze({
    name: 'EvDCCharger',

    serial: new ModbusRegistry(setting.INFO, 30515, 10, type.string, 'Serial'),
    current: new ModbusRegistry(setting.READING, 31501, 1, type.uint16_10, 'Charging current'),
    power: new ModbusRegistry(setting.READING, 31502, 2, type.int32_1, 'Output power'),
    vehicleBatteryVoltage: new ModbusRegistry(setting.READING, 31500, 1, type.uint16_10, 'Vehicle battery voltage'),
    vehicleSoc: new ModbusRegistry(setting.READING, 31504, 1, type.uint16_10, 'Vehicle SOC'),

    // New statistics interface
    totalChargeEnergy: new ModbusRegistry(setting.SYSTEM, 30252, 4, type.uint64_100, 'Total charged energy EVDC'),
    totalDischargeEnergy: new ModbusRegistry(setting.SYSTEM, 30256, 4, type.uint64_100, 'Total discharged energy EVDC')

});

module.exports = {
    EvDCChargerRegistry
}