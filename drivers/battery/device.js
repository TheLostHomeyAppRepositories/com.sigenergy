'use strict';

const Battery = require('../../lib/devices/battery.js');
const BaseDevice = require('../baseDevice.js');
const enums = require('../../lib/enums.js');

class BatteryDevice extends BaseDevice {

    async onInit() {
        await this.upgradeDevice();
        await super.onInit();
    }

    async upgradeDevice() {
        this.logMessage('Upgrading existing device');

    }

    async setupSession(host, port, modbus_unitId, refreshInterval) {
        this.api = new Battery({
            host: host,
            port: port,
            modbus_unitId: modbus_unitId,
            refreshInterval: refreshInterval,
            device: this
        });

        await this.api.initialize();
        await this._initializeEventListeners();
    }

    async _initializeEventListeners() {
        this.api.on('properties', this._handlePropertiesEvent.bind(this));
        this.api.on('readings', this._handleReadingsEvent.bind(this));
        this.api.on('error', this._handleErrorEvent.bind(this));
    }

    _handlePropertiesEvent(message) {
        this.updateSetting('serial', message.serial);
        this.updateSetting('capacity', message.capacity);
    }

    async _handleReadingsEvent(message) {
        try {
            await this._updateBatteryProperties(message);
        } catch (error) {
            this.error('Failed to process battery readings event:', error);
        }
    }

    async _updateBatteryProperties(message) {
        await Promise.all([
            this._updateProperty('measure_battery', message.soc),
            this._updateProperty('measure_power', message.power),
            this._updateProperty('measure_temperature.minCell', message.minCellTemperature),
            this._updateProperty('measure_temperature.maxCell', message.maxCellTemperature),
            // this._updateProperty('measure_voltage.minCell', message.minCellVoltage),
            // this._updateProperty('measure_voltage.maxCell', message.maxCellVoltage),

            this._updateProperty('battery_charging_state', enums.decodeBatteryChargingState(message.status, message.power)),
            this._updateProperty('meter_power.charged', message.totalChargeEnergy),
            this._updateProperty('meter_power.discharged', message.totalDischargeEnergy),
        ]);
    }
}
module.exports = BatteryDevice;
