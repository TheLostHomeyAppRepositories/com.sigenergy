'use strict';

const EVDCCharger = require('../../lib/devices/evDCCharger.js');
const BaseDevice = require('../baseDevice.js');
const enums = require('../../lib/enums.js');
const utilFunctions = require('../../lib/util.js');

// Store keys for the charger's rated power values. Persisted so the power-limit
// flow actions keep their bounds across restarts, and read from the store on
// every use rather than from an instance field.
const STORE_RATED_CHARGING_POWER = 'dc_rated_charging_power';
const STORE_RATED_DISCHARGING_POWER = 'dc_rated_discharging_power';

class EvDCChargerDevice extends BaseDevice {

    async onInit() {
        await this.upgradeDevice();
        await this.setupCapabilityListeners();
        await super.onInit();
    }

    async upgradeDevice() {
        this.logMessage('Upgrading existing device');

        // v2.9 capabilities
        await this.addCapabilityHelper('evdc_running_state');
        await this.addCapabilityHelper('measure_current.discharge');
        await this.addCapabilityHelper('evdc_max_charge_power');
        await this.addCapabilityHelper('evdc_max_discharge_power');
        await this.addCapabilityHelper('meter_power.session_charged');
        await this.addCapabilityHelper('meter_power.session_discharged');
    }

    createApi(options) {
        return new EVDCCharger(options);
    }

    async setupCapabilityListeners() {
        this.registerCapabilityListener('evcharger_charging', async (value) => {
            if (value) {
                // Start
                await this.api.startCharging()
                    .catch(reason => {
                        this.error('Failed to start charging!', reason);
                        throw new Error(`Failed to start charging! ${reason.message}`);
                    });

            } else {
                // Stop
                await this.api.stopCharging()
                    .catch(reason => {
                        this.error('Failed to stop charging!', reason);
                        throw new Error(`Failed to stop charging! ${reason.message}`);
                    });
            }
        });
    }

    /**
     * Public method - used by flow action cards.
     */
    async setMaxChargePower(kW) {
        const clamped = utilFunctions.clampPower(kW, this._getRatedPower('charging'));
        await this.api.setMaxChargePower(clamped)
            .catch(reason => {
                this.error('Failed to set max charging power!', reason);
                throw new Error(`Failed to set max charging power! ${reason.message}`);
            });
        return true;
    }

    /**
     * Public method - used by flow action cards.
     */
    async setMaxDischargePower(kW) {
        const clamped = utilFunctions.clampPower(kW, this._getRatedPower('discharging'));
        await this.api.setMaxDischargePower(clamped)
            .catch(reason => {
                this.error('Failed to set max discharging power!', reason);
                throw new Error(`Failed to set max discharging power! ${reason.message}`);
            });
        return true;
    }

    /**
     * Resolve a clamp bound from the device store, falling back to the matching
     * display setting. Read on every use rather than cached, see
     * BaseDevice.getPersistedNumber.
     */
    _getRatedPower(label) {
        return label === 'charging'
            ? this.getPersistedNumber(STORE_RATED_CHARGING_POWER, 'ratedChargingPower')
            : this.getPersistedNumber(STORE_RATED_DISCHARGING_POWER, 'ratedDischargingPower');
    }

    async _handlePropertiesEvent(message) {
        try {
            // persistNumber ignores unusable values, so a failed or unsupported
            // read leaves the previously stored bound intact and returns it.
            const ratedChargingPower = await this.persistNumber(
                STORE_RATED_CHARGING_POWER,
                message.ratedChargingPower
            );
            const ratedDischargingPower = await this.persistNumber(
                STORE_RATED_DISCHARGING_POWER,
                message.ratedDischargingPower
            );

            // Settings hold the same values unit-suffixed, for display only.
            const settings = {
                ratedChargingPower: ratedChargingPower !== undefined ? `${ratedChargingPower} kW` : '',
                ratedDischargingPower: ratedDischargingPower !== undefined ? `${ratedDischargingPower} kW` : ''
            };

            // Only touch the serial when the register actually returned one,
            // otherwise a failed read would overwrite it with the string
            // "undefined".
            if (typeof message.serial === 'string' && message.serial.length > 0) {
                settings.serial = message.serial;
            }

            await this.setSettings(settings);
        } catch (error) {
            this.error('Failed to update EV DC charger properties settings:', error);
        }
    }

    async _handleReadingsEvent(message) {
        try {
            await this._updateEvChargerProperties(message);
        } catch (error) {
            this.error('Failed to process EV DC charger readings event:', error);
        }
    }

    async _updateEvChargerProperties(message) {
        const isCharging = message.power > 0;
        const runningStateName = enums.decodeDCChargerState(message.runningState);
        const chargingState = Number.isFinite(message.runningState)
            ? enums.mapDCChargerStateToChargingState(message.runningState, message.power)
            : this._fallbackChargingState(message);

        await Promise.all([
            // EV charger capabilities
            this._updateProperty('evcharger_charging', isCharging),
            this._updateProperty('evcharger_charging_state', chargingState),
            this._updateProperty('evdc_running_state', runningStateName),

            // Power & current
            this._updateProperty('measure_power', message.power),
            this._updateProperty('measure_current', message.current),
            this._updateProperty('measure_current.discharge', message.dischargeCurrent),
            this._updateProperty('measure_voltage.vehicle', message.vehicleBatteryVoltage > 10 ? message.vehicleBatteryVoltage : 0),
            this._updateProperty('measure_battery.vehicle', message.vehicleSoc || 0),

            // Power limits (read back current values from device)
            this._updateProperty('evdc_max_charge_power', message.maxChargePowerLimit),
            this._updateProperty('evdc_max_discharge_power', message.maxDischargePowerLimit),

            // Session counters
            this._updateProperty('meter_power.session_charged', message.sessionChargeEnergy),
            this._updateProperty('meter_power.session_discharged', message.sessionDischargeEnergy),

            // Lifetime totals (system register)
            this._updateProperty('meter_power.charged', message.totalChargeEnergy),
            this._updateProperty('meter_power.discharged', message.totalDischargeEnergy)
        ]);
    }

    async _handlePropertyTriggers(key, value) {
        if (key === 'evdc_running_state' && typeof value === 'string') {
            try {
                await this.driver._dc_charger_state_changed?.trigger(this, {}, { value });
            } catch (error) {
                this.error('Failed to trigger dc_charger_state_changed:', error);
            }
        }
    }

    /**
     * Fallback when running state register is unavailable - infers state
     * from power and vehicle battery voltage like the v2.8 implementation.
     */
    _fallbackChargingState(message) {
        if (message.power > 0) {
            return 'plugged_in_charging';
        } else if (message.power < 0) {
            return 'plugged_in_discharging';
        } else if (message.power === 0 && message.vehicleBatteryVoltage > 10) {
            return 'plugged_in';
        } else {
            return 'plugged_out';
        }
    }
}
module.exports = EvDCChargerDevice;
