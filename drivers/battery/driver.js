'use strict';

const BaseDriver = require('../baseDriver.js');
const { BatteryRegistry } = require('../../lib/modbus/registry/battery.js');
const enums = require('../../lib/enums.js');

class BatteryDriver extends BaseDriver {

    async onInit() {
        this._registerFlows();
    }

    _registerFlows() {
        this.log('Registering flows');

        // Grid status changed, triggered automatically by Homey given namingstandard
        this._grid_status_changed = this.homey.flow.getDeviceTriggerCard('grid_status_changed');
        this._grid_status_changed.registerRunListener(async (args, state) => {
            this.log(`Comparing '${args.status.name}' with '${state.value}'`);
            return args.status.name == state.value;
        });
        this._grid_status_changed.registerArgumentAutocompleteListener('status',
            async (query, args) => {
                return enums.getGridStatuses();
            }
        );
    }

    triggerGridStatusChanged(device, tokens) {
        this.log(`Triggering grid status changed for device ${device.id} with tokens ${JSON.stringify(tokens)}`);
        this._grid_status_changed.trigger(device, {}, tokens).catch(error => { this.error(error) });
    }

    async onPair(session) {
        return await super.pair(BatteryRegistry.serial, 'Battery', session);
    }

}
module.exports = BatteryDriver;
