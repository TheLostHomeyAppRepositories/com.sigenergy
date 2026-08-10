'use strict';
const { PlantRegistry } = require('../modbus/registry/plant.js');
const Base = require('../base.js');
const utilFunctions = require('../util.js');

class Plant extends Base {
    constructor(options) {
        super(PlantRegistry, options);
    }

    /**
     * Set the plant-wide ESS maximum charging power limit (in kW).
     *
     * Register 40032, U32, gain 1000. Allowed range [0, rated ESS charging
     * power]. Per the Modbus spec this takes effect globally regardless of the
     * EMS operating mode, so it does not require remote EMS to be enabled.
     *
     * Plant registers are only addressable on unit id 247, which is the unit id
     * the plant device is paired with, so no unit id override is needed here.
     */
    setEssMaxChargingLimit(kW) {
        return this.writeRegisters(40032, utilFunctions.createBuffer32(kW, 1000));
    }

    /**
     * Set the plant-wide ESS maximum discharging power limit (in kW).
     *
     * Register 40034, U32, gain 1000. Allowed range [0, rated ESS discharging
     * power]. Writing 0 stops the battery from discharging altogether; a
     * non-zero value caps how much it may contribute.
     *
     * Note: while no limit has ever been set, 40032/40034 read back as
     * 0xFFFFFFFF rather than 0 (confirmed on hardware). That sentinel is
     * outside the documented writable range, so "remove the limit" writes the
     * rated power instead - the plant cannot exceed its rated power anyway, so
     * the effect is the same without writing an undocumented value. Readback of
     * these registers is also reported to be unreliable in some EMS modes, so
     * they are deliberately not surfaced as capabilities.
     */
    setEssMaxDischargingLimit(kW) {
        return this.writeRegisters(40034, utilFunctions.createBuffer32(kW, 1000));
    }
}

module.exports = Plant;
