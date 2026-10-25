'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const Plant = require('../../lib/devices/plant.js');

function fakeApi(raw) {
    const calls = [];
    return {
        calls,
        async readRegisters(registryId, count) {
            calls.push([registryId, count]);
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32BE(raw, 0);
            return buffer;
        }
    };
}

test('readEssLimit reads 40034 for discharging and 40032 for charging, in kW', async () => {
    const discharging = fakeApi(0);
    assert.equal(await Plant.prototype.readEssLimit.call(discharging, 'discharging'), 0);
    assert.deepEqual(discharging.calls, [[40034, 2]]);

    const charging = fakeApi(8200);
    assert.equal(await Plant.prototype.readEssLimit.call(charging, 'charging'), 8.2);
    assert.deepEqual(charging.calls, [[40032, 2]]);
});

test('readEssLimit reports the 0xFFFFFFFF "no limit set" sentinel as null', async () => {
    assert.equal(await Plant.prototype.readEssLimit.call(fakeApi(0xFFFFFFFF), 'discharging'), null);
});
