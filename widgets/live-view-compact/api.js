'use strict';

module.exports = {
  async getLiveViewData({ homey, query }) {

    const plantDevices = homey.drivers.getDriver('plant').getDevices();
    if (plantDevices.length > 0) {
      const plantDevice = plantDevices[0];
      return await plantDevice.getLiveViewData();
    } else {
      return {
        error: 'The widget requires a Sigenergy Plant device'
      }
    }
  },
};