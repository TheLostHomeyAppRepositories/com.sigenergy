'use strict';

const Plant = require('../../lib/devices/plant.js');
const BaseDevice = require('../baseDevice.js');
const enums = require('../../lib/enums.js');
const utilFunctions = require('../../lib/util.js');

// Store keys for the rated ESS power values. Persisted so the power-limit flow
// actions still know the plant's bounds immediately after a restart, before the
// first INFO register read of the new session has completed.
const STORE_RATED_CHARGING_POWER = 'ess_rated_charging_power';
const STORE_RATED_DISCHARGING_POWER = 'ess_rated_discharging_power';

class PlantDevice extends BaseDevice {

    async onInit() {
        await this.upgradeDevice();
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
        return new Plant(options);
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
            await this.setSettings({
                ratedChargingPower: ratedChargingPower !== undefined ? `${ratedChargingPower} kW` : '',
                ratedDischargingPower: ratedDischargingPower !== undefined ? `${ratedDischargingPower} kW` : ''
            });
        } catch (error) {
            this.error('Failed to update plant properties settings:', error);
        }
    }

    /**
     * Public method - used by flow action cards.
     *
     * Caps how much power the battery may draw while charging. Writing 0 stops
     * it charging altogether.
     */
    async setEssMaxChargePower(kW) {
        const clamped = utilFunctions.clampPower(kW, this._getRatedPower('charging'));
        return this._writeEssLimit('charging', clamped);
    }

    /**
     * Public method - used by flow action cards.
     *
     * Caps how much power the battery may supply while discharging. Writing 0
     * stops it discharging altogether, which is the building block for "don't
     * drain the battery into the car while it charges".
     */
    async setEssMaxDischargePower(kW) {
        const clamped = utilFunctions.clampPower(kW, this._getRatedPower('discharging'));
        return this._writeEssLimit('discharging', clamped);
    }

    /**
     * Public method - used by flow action cards.
     *
     * Restores unrestricted charging by writing the plant's rated charging
     * power, which is the top of the register's documented range.
     */
    async removeEssChargeLimit() {
        return this._writeEssLimit('charging', this._requireRatedPower('charging'));
    }

    /**
     * Public method - used by flow action cards.
     *
     * Restores unrestricted discharging by writing the plant's rated
     * discharging power.
     */
    async removeEssDischargeLimit() {
        return this._writeEssLimit('discharging', this._requireRatedPower('discharging'));
    }

    /**
     * The rated power registers define the upper bound of the limit registers,
     * so removing a limit is only meaningful once they have been read. Fail
     * loudly rather than guessing a value the plant may reject.
     */
    _requireRatedPower(label) {
        const rated = this._getRatedPower(label);
        if (rated === undefined) {
            throw new Error(`Cannot remove the battery ${label} limit: the plant's rated ${label} power is not known yet. Wait for the device to report it, or set an explicit power limit instead.`);
        }
        return rated;
    }

    async _writeEssLimit(label, kW) {
        if (!this.api) {
            throw new Error(`Failed to set max ${label} power! Device is not connected.`);
        }

        const write = label === 'charging'
            ? this.api.setEssMaxChargingLimit(kW)
            : this.api.setEssMaxDischargingLimit(kW);

        await write.catch(reason => {
            this.error(`Failed to set max ${label} power!`, reason);
            throw new Error(`Failed to set max ${label} power! ${utilFunctions.formatError(reason)}`);
        });

        this.logMessage(`Set ESS max ${label} power to ${kW} kW`);
        return true;
    }

    async _handleReadingsEvent(message) {
        try {
            await this._updatePlantProperties(message);
        } catch (error) {
            this.error('Failed to process inverter readings event:', error);
        }
    }

    /**
     * Total PV power is the plant's own production plus any third-party inverter
     * feeding the same plant.
     *
     * Third-party inverter power (30194) is optional: it only exists on plants
     * that have one, and the register was added in protocol V2.7, so a missing
     * value counts as zero. The plant's own PV power is required - without it
     * there is no total to report, and returning the third-party figure alone
     * (or 0) would understate production. Returning undefined leaves the
     * capability at its last known value instead.
     */
    _resolveSolarPower(message) {
        if (!Number.isFinite(message.solarPower)) {
            return undefined;
        }

        const thirdParty = Number.isFinite(message.thirdPartyInverterPower)
            ? message.thirdPartyInverterPower
            : 0;

        return message.solarPower + thirdParty;
    }

    async _updatePlantProperties(message) {

        const evChargerPower = await this.calculateEVChargerPower();

        await Promise.all([
            this._updateProperty('measure_power.grid', message.gridPower),
            this._updateProperty('measure_power.battery', message.batteryPower),
            this._updateProperty('measure_power.solar', this._resolveSolarPower(message)),
            this._updateProperty('measure_power.load', message.generalLoadPower),
            this._updateProperty('measure_power.evcharger', evChargerPower),
            this._updateProperty('measure_battery', message.batterySoc),
        ]);

        if (Number.isFinite(message.gridStatus)) {
            await this.setStoreValue('grid_status', enums.decodeGridStatus(message.gridStatus));
        }

        await this.sendLiveViewData();
    }

    async sendLiveViewData() {
        this.homey.api.realtime('liveview.data.update', await this.getLiveViewData());
    }

    async getLiveViewData() {
        return {
            grid: {
                power: this.getCapabilityValue('measure_power.grid') / 1000,
                status: this.getStoreValue('grid_status')
            },
            solar: {
                power: this.getCapabilityValue('measure_power.solar') / 1000
            },
            home: {
                power: this.getCapabilityValue('measure_power.load') / 1000
            },
            evcharger: {
                power: this.getCapabilityValue('measure_power.evcharger') / 1000
            },
            battery: {
                power: this.getCapabilityValue('measure_power.battery') / 1000,
                soc: this.getCapabilityValue('measure_battery')
            }
        }
    }

    async calculateEVChargerPower() {
        let power = 0;

        // A charger whose measure_power is not known yet (newly added, or its
        // register has not read successfully) contributes nothing rather than
        // poisoning the sum with null/NaN.
        const addChargerPower = charger => {
            const value = charger.getCapabilityValue('measure_power');
            if (Number.isFinite(value)) {
                power = power + value;
            }
        };

        this.homey.drivers.getDriver('evdccharger').getDevices().forEach(addChargerPower);
        this.homey.drivers.getDriver('evaccharger').getDevices().forEach(addChargerPower);

        return power;
    }
}
module.exports = PlantDevice;
