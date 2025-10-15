'use strict';

const Energy = require('../../lib/devices/energy.js');
const BaseDevice = require('../baseDevice.js');
const enums = require('../../lib/enums.js');

class EnergyDevice extends BaseDevice {

    async onInit() {
        await this.upgradeDevice();
        await super.onInit();
    }

    async upgradeDevice() {
        this.logMessage('Upgrading existing device');

        await this.addCapabilityHelper('grid_status');
    }

    async setupSession(host, port, modbus_unitId, refreshInterval) {
        this.api = new Energy({
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
        //this.api.on('properties', this._handlePropertiesEvent.bind(this));
        this.api.on('readings', this._handleReadingsEvent.bind(this));
        this.api.on('error', this._handleErrorEvent.bind(this));
    }

    // _handlePropertiesEvent(message) {
    //     this.updateSetting('serial', message.serial);
    // }

    async _handleReadingsEvent(message) {
        try {
            await this._updateEnergyMeterProperties(message);
        } catch (error) {
            this.error('Failed to process energy meter readings event:', error);
        }
    }

    async _updateEnergyMeterProperties(message) {
        await Promise.all([
            this._updateProperty('grid_status', enums.decodeGridStatus(message.gridStatus)),

            // Total power measurement
            this._updateProperty('measure_power', message.power),

            // Phase L1 measurements
            this._updateProperty('measure_power.L1', message.powerL1 || 0),
            // this._updateProperty('measure_current.L1', message.currentL1 || 0),
            // this._updateProperty('measure_voltage.L1', message.voltageL1 ? Math.round(message.voltageL1) : 0),

            // Phase L2 measurements
            this._updateProperty('measure_power.L2', message.powerL2 || 0),
            // this._updateProperty('measure_current.L2', message.currentL2 || 0),
            // this._updateProperty('measure_voltage.L2', message.voltageL2 ? Math.round(message.voltageL2) : 0),

            // Phase L3 measurements
            this._updateProperty('measure_power.L3', message.powerL3 || 0),
            // this._updateProperty('measure_current.L3', message.currentL3 || 0),
            // this._updateProperty('measure_voltage.L3', message.voltageL3 ? Math.round(message.voltageL3) : 0),

            // Energy meters
            this._updateProperty('meter_power.imported', message.totalImportedEnergy || 0),
            this._updateProperty('meter_power.exported', message.totalExportedEnergy || 0)
        ]);
    }

}
module.exports = EnergyDevice;
