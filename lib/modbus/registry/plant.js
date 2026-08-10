'use strict';

const { ModbusRegistry, type, setting } = require('../modbusRegistry.js');

const PlantRegistry = Object.freeze({
    name: 'Plant',

    // Rated ESS power - read once. Used to bound the configurable ESS power
    // limits (40032/40034) and as the value written to remove a limit, since
    // the spec defines their range as [0, rated power].
    ratedChargingPower: new ModbusRegistry(setting.INFO, 30068, 2, type.uint32_1000, 'ESS rated charging power'),
    ratedDischargingPower: new ModbusRegistry(setting.INFO, 30070, 2, type.uint32_1000, 'ESS rated discharging power'),

    gridPower: new ModbusRegistry(setting.READING, 30005, 2, type.int32_1, 'Grid power'),
    gridStatus: new ModbusRegistry(setting.READING, 30009, 1, type.uint16_1, 'Grid status'),
    batterySoc: new ModbusRegistry(setting.READING, 30014, 1, type.uint16_10, 'Battery SoC'),
    solarPower: new ModbusRegistry(setting.READING, 30035, 2, type.int32_1, 'Solar power'),
    batteryPower: new ModbusRegistry(setting.READING, 30037, 2, type.int32_1, 'Battery power'),
    generalLoadPower: new ModbusRegistry(setting.READING, 30282, 2, type.int32_1, 'General load power'),
    thirdPartyInverterPower: new ModbusRegistry(setting.READING, 30194, 2, type.int32_1, 'Third party inverter power')
});

module.exports = {
    PlantRegistry
}