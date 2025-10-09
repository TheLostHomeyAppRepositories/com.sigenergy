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

    async _handlePropertiesEvent(message) {
        try {
            await this.setSettings({
                serial: String(message.serial),
                mpptCount: String(message.mpptCount)
            });

            await this._configurePVCapabilities(message.mpptCount);
        } catch (error) {
            this.error('Failed to update inverter properties settings:', error);
        }
    }

    async _configurePVCapabilities(mpptCount) {
        // Array of all possible PV voltage capabilities
        const allPVCapabilities = [
            'measure_voltage.pv1',
            'measure_voltage.pv2',
            'measure_voltage.pv3',
            'measure_voltage.pv4'
        ];

        // Add or keep capabilities based on mpptCount
        for (let i = 0; i < allPVCapabilities.length; i++) {
            if (i < mpptCount) {
                // Keep/add this capability
                await this.addCapabilityHelper(allPVCapabilities[i]);
            } else {
                // Remove this capability if it exists
                await this.removeCapabilityHelper(allPVCapabilities[i]);
            }
        }

        this.logMessage(`Configured ${mpptCount} PV voltage capabilities`);
    }

    async _handleReadingsEvent(message) {
        try {
            await this._updateSolarChargerProperties(message);
        } catch (error) {
            this.error('Failed to process inverter readings event:', error);
        }
    }

    async _updateSolarChargerProperties(message) {
        let updates = [
            this._updateProperty('measure_power', message.power || 0),
            this._updateProperty('meter_power.daily', message.dailyYield || 0),
            this._updateProperty('meter_power', message.totalYield || 0)
        ];

        // Only update PV voltages based on mpptCount
        const mpptCount = Number(this.getSetting('mpptCount'));
        if (mpptCount >= 1) {
            updates.push(this._updateProperty('measure_voltage.pv1', message.pv1Voltage || 0));
        }
        if (mpptCount >= 2) {
            updates.push(this._updateProperty('measure_voltage.pv2', message.pv2Voltage || 0));
        }
        if (mpptCount >= 3) {
            updates.push(this._updateProperty('measure_voltage.pv3', message.pv3Voltage || 0));
        }
        if (mpptCount >= 4) {
            updates.push(this._updateProperty('measure_voltage.pv4', message.pv4Voltage || 0));
        }

        await Promise.all(updates);
    }
}
module.exports = InverterDevice;
