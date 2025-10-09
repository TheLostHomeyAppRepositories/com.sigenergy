'use strict';

const Inverter = require('../../lib/devices/inverter.js');
const BaseDevice = require('../baseDevice.js');

class InverterDevice extends BaseDevice {

    async onInit() {
        await this.upgradeDevice();
        await super.onInit();
    }

    async upgradeDevice() {
        this.logMessage('Upgrading existing device');

    }

    async setupSession(host, port, modbus_unitId, refreshInterval) {
        this.api = new Inverter({
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
    }

    async _handleReadingsEvent(message) {
        try {
            await this._updateSolarChargerProperties(message);
        } catch (error) {
            this.error('Failed to process solar charger readings event:', error);
        }
    }

    async _updateSolarChargerProperties(message) {
        await Promise.all([
            this._updateProperty('measure_power', message.power || 0),
            this._updateProperty('meter_power.daily', message.dailyYield || 0),
            this._updateProperty('meter_power', message.totalYield || 0)
        ]);
    }
}
module.exports = InverterDevice;
