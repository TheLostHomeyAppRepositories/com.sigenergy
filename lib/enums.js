'use strict';

const Enum = require('enum');

exports.getBatteryStatuses = function () {
    return getEnumAsJson(batteryStatus);
}

/////////////////

exports.decodeBatteryStatus = function (numType) {
    return lookupEnumKey(batteryStatus, numType);
}

exports.decodeBatteryChargingState = function (numType, power) {
    switch (numType) {
        case 0: // standby
        case 2: // fault
        case 3: // shutdown
        case 7: // abnormality
            return 'idle';
        case 1: // running
            return power > 0 ? 'charging' : 'discharging';
        default:
            return 'idle';
    }
}

// Lower case to match battery_charging_state
const batteryStatus = new Enum({
    'Standby': 0,
    'Running': 1,
    'Fault': 2,
    'Shutdown': 3,
    'Abnormality': 7
});

function lookupEnumKey(enumObject, value) {
    if (enumObject.get(value)) {
        return enumObject.get(value).key;
    } else {
        return `UNKNOWN (${value})`
    }
}

function getEnumAsJson(enumObject) {
    let values = [];
    enumObject.enums.forEach(function (entry) {
        values.push({
            id: `${entry.value}`,
            name: `${entry.key}`
        });
    });
    return values;
}