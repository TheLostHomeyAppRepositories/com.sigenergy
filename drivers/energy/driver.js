'use strict';

const BaseDriver = require('../baseDriver.js');
const { EnergyRegistry } = require('../../lib/modbus/registry/energy.js');
const enums = require('../../lib/enums.js');

class EnergyDriver extends BaseDriver {

    async onInit() {
        this._registerFlows();
    }

    _registerFlows() {
        this.log('Registering flows');

        // Grid status changed, triggered automatically by Homey given namingstandard
        this._grid_status_changed = this.homey.flow.getDeviceTriggerCard('grid_status_changed');
        this._grid_status_changed.registerRunListener(async (args, state) => {
            this.log(`Args: status.name='${args.status?.name}', state.value='${state.value}'`);
            const result = args.status?.name == state.value;
            this.log(`Grid status comparison result: ${result}`);
            return result;
        });
        this._grid_status_changed.registerArgumentAutocompleteListener('status',
            async (query, args) => {
                return enums.getGridStatuses();
            }
        );

        // Phase control changed, triggered automatically by Homey given namingstandard
        this._phase_control_changed = this.homey.flow.getDeviceTriggerCard('phase_control_changed');
        this.log(`Phase control trigger card registered: ${!!this._phase_control_changed}`);
        this._phase_control_changed.registerRunListener(async (args, state) => {
            this.log(`Args: control.name='${args.control?.name}', state.value='${state.value}'`);
            const result = args.control?.name == state.value;
            this.log(`Phase control comparison result: ${result}`);
            return result;
        });
        this._phase_control_changed.registerArgumentAutocompleteListener('control',
            async (query, args) => {
                return enums.getPhaseControl();
            }
        );
    }

    async onPair(session) {
        return await super.pair(EnergyRegistry.power, 'Energy Meter', session, true);
    }

}
module.exports = EnergyDriver;