'use strict';

module.exports = {
  async getLiveViewData({ homey, query }) {

    return await homey.app.getLiveViewData();

  },
};
