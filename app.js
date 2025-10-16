'use strict';

const { App } = require('homey');

class SigenergyApp extends App {
    async onInit() {
        await this.loadConditions();
        await this.loadActions();
        this.log(`Sigenergy v${this.getAppVersion()} has been initialized`);
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
}
module.exports = SigenergyApp;