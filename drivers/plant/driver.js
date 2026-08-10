'use strict';

const BaseDriver = require('../baseDriver.js');
const { PlantRegistry } = require('../../lib/modbus/registry/plant.js');

class PlantDriver extends BaseDriver {

    async onInit() {
        this._registerFlows();
    }

    _registerFlows() {
        this.log('Registering flows');

        // Action: Cap the battery's discharging power (0 = no discharging)
        this.homey.flow.getActionCard('set_ess_max_discharge_power')
            .registerRunListener(async (args) => {
                return await args.device.setEssMaxDischargePower(args.power);
            });

        // Action: Cap the battery's charging power (0 = no charging)
        this.homey.flow.getActionCard('set_ess_max_charge_power')
            .registerRunListener(async (args) => {
                return await args.device.setEssMaxChargePower(args.power);
            });

        // Action: Restore unrestricted discharging
        this.homey.flow.getActionCard('remove_ess_discharge_limit')
            .registerRunListener(async (args) => {
                return await args.device.removeEssDischargeLimit();
            });

        // Action: Restore unrestricted charging
        this.homey.flow.getActionCard('remove_ess_charge_limit')
            .registerRunListener(async (args) => {
                return await args.device.removeEssChargeLimit();
            });
    }

    async onPair(session) {
        return await super.pair(PlantRegistry.gridPower, 'Plant', session, true);
    }
}
module.exports = PlantDriver;
