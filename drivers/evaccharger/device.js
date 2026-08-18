'use strict';

const EVACCharger = require('../../lib/devices/evACCharger.js');
const BaseDevice = require('../baseDevice.js');
const enums = require('../../lib/enums.js');

class EvACChargerDevice extends BaseDevice {

    async onInit() {
        await this.upgradeDevice();
        await this.setupCapabilityListeners();
        await super.onInit();
    }

    /**
     * Capability migrations for devices paired by an older app version. The
     * add/remove helpers log only when they actually change something, so an
     * already up-to-date device produces no output. Nothing to migrate yet.
     */
    async upgradeDevice() {
    }

    createApi(options) {
        return new EVACCharger(options);
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

    // async _handlePropertiesEvent(message) {
    //     try {
    //         await this.setSettings({
    //             serial: String(message.serial)
    //         });
    //     } catch (error) {
    //         this.error('Failed to update EV DC charger properties settings:', error);
    //     }
    // }

    async _handleReadingsEvent(message) {
        try {
            await this._updateEvChargerProperties(message);
        } catch (error) {
            this.error('Failed to process EV DC charger readings event:', error);
        }
    }

    async _updateEvChargerProperties(message) {
        // Without a power reading there is nothing to infer charging from, so
        // leave the capability as it is instead of reporting "not charging".
        // chargingState is covered by the status register itself: its mapper
        // returns undefined when that register was not read.
        const isCharging = Number.isFinite(message.power) ? message.power > 0 : undefined;
        const chargingState = enums.mapACChargerStatusToChargingState(message.status, message.power);

        await Promise.all([
            // EV charger specific capabilities
            this._updateProperty('evcharger_charging', isCharging),
            this._updateProperty('evcharger_charging_state', chargingState),

            // Standard measurements
            this._updateProperty('measure_power', message.power),
            this._updateProperty('meter_power.charged', message.totalChargeEnergy)
        ]);
    }
}
module.exports = EvACChargerDevice;
