'use strict';

const { App } = require('homey');

class SigenergyApp extends App {
    async onInit() {
        await this.loadConditions();
        await this.loadActions();
        this.log(`Sigenergy v${this.getAppVersion()} has been initialized`);

        // Update liveview data every 2 seconds
        this.homey.setInterval(async () => {
            this.homey.api.realtime('liveview.data.update', await this.getLiveViewData());
        }, 2000); // 2 seconds
    }

    getAppVersion() {
        return this.homey.manifest.version;
    }

    async loadConditions() {
        this.log('Loading conditions...');

    }

    async loadActions() {
        this.log('Loading actions...');

    }

    async getLiveViewData() {
        try {
            const liveViewData = {
                solar: null,
                battery: null,
                grid: null,
                charger: null,
                home: null
            };

            liveViewData.battery = await this.getBatteryLiveViewData();
            liveViewData.solar = await this.getSolarLiveViewData();
            liveViewData.grid = await this.getGridLiveViewData();
            liveViewData.charger = await this.getChargerLiveViewData();
            liveViewData.home = await this.calculateHomeConsumption(liveViewData);

            return liveViewData;

        } catch (error) {
            this.error('Error collecting LiveView data:', error);
            return {
                solar: null,
                battery: null,
                grid: null,
                charger: null,
                home: null,
                error: error.message
            };
        }
    }

    async calculateHomeConsumption(liveViewData) {
        return {
            power: liveViewData.solar.power + liveViewData.grid.power - liveViewData.battery.power - liveViewData.charger.power
        };
    }

    async getSolarLiveViewData() {
        let power = 0;
        const solarDevices = this.homey.drivers.getDriver('inverter').getDevices();
        for (const solar of solarDevices) {
            power = power + solar.getCapabilityValue('measure_power');
        }

        return {
            power: power / 1000
        };
    }

    async getGridLiveViewData() {
        let power = 0;
        const gridDevices = this.homey.drivers.getDriver('energy').getDevices();
        for (const grid of gridDevices) {
            power = power + grid.getCapabilityValue('measure_power');
        }

        return {
            power: power / 1000
        };
    }

    async getChargerLiveViewData() {
        let power = 0;

        const dcchargerDevices = this.homey.drivers.getDriver('evdccharger').getDevices();
        for (const charger of dcchargerDevices) {
            power = power + charger.getCapabilityValue('measure_power');
        }

        const acchargerDevices = this.homey.drivers.getDriver('evaccharger').getDevices();
        for (const charger of acchargerDevices) {
            power = power + charger.getCapabilityValue('measure_power');
        }

        return {
            power: power / 1000
        };
    }

    async getBatteryLiveViewData() {
        let power = 0;
        let batterySoc = 0;
        let batteryGridStatus = null;
        const batteryDevices = this.homey.drivers.getDriver('battery').getDevices();
        const batteryCount = batteryDevices.length;

        for (const battery of batteryDevices) {
            power = power + battery.getCapabilityValue('measure_power');
            batterySoc = batterySoc + battery.getCapabilityValue('measure_battery');
            batteryGridStatus = battery.getCapabilityValue('grid_status');
        }

        return {
            power: power / 1000,
            soc: batteryCount > 0 ? (batterySoc / batteryCount) : 0,
            gridStatus: batteryGridStatus
        };

    }
}
module.exports = SigenergyApp;