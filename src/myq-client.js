'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const IDENTITY = 'https://partner-identity.myq-cloud.com';
const APP_VERSION = '5.243.1.73243';
const BRAND_ID = '1';
const USER_AGENT = 'sdk_gphone_x86/Android 11';
const CLIENT_ID = 'ANDROID_CGI_MYQ';
const REDIRECT_URI = 'com.myqops://android';
const SCOPE = 'MyQ_Residential offline_access';
const ENDPOINTS = {
  accounts: 'https://accounts.myq-cloud.com/api/v6.0/accounts',
  devices: 'https://devices.myq-cloud.com/api/v6.2/Accounts',
  doors: 'https://account-devices-gdo.myq-cloud.com/api/v6.0/accounts',
};

class MyQClient {
  constructor(refreshToken, storagePath, log = console, fetchImpl = fetch) {
    this.refreshToken = refreshToken;
    this.fetch = fetchImpl;
    this.log = log;
    this.tokenPath = path.join(storagePath, 'myq-cloud-token.json');
    this.token = null;
    this.tokenPromise = null;
  }

  async loadToken() {
    if (this.token) return;
    try {
      const data = JSON.parse(await fs.readFile(this.tokenPath, 'utf8'));
      if (data.refreshToken) this.refreshToken = data.refreshToken;
      if (data.accessToken && data.expiresAt > Date.now() + 60000) this.token = data.accessToken;
    } catch (error) {
      if (error.code !== 'ENOENT') this.log.warn(`Unable to read saved MyQ token: ${error.message}`);
    }
  }

  async accessToken() {
    await this.loadToken();
    if (this.token) return this.token;
    if (!this.tokenPromise) this.tokenPromise = this.refreshAccessToken().finally(() => { this.tokenPromise = null; });
    return this.tokenPromise;
  }

  async refreshAccessToken() {
    const response = await this.fetch(`${IDENTITY}/connect/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'App-Version': APP_VERSION, BrandId: BRAND_ID, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE, redirect_uri: REDIRECT_URI, grant_type: 'refresh_token', refresh_token: this.refreshToken }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`MyQ token refresh returned HTTP ${response.status}; reauthorize the account and replace refreshToken`);
    if (!payload.access_token || typeof payload.expires_in !== 'number') throw new Error('MyQ token refresh response was incomplete');
    this.token = payload.access_token;
    if (payload.refresh_token) this.refreshToken = payload.refresh_token;
    await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
    await fs.writeFile(this.tokenPath, JSON.stringify({ accessToken: this.token, refreshToken: this.refreshToken, expiresAt: Date.now() + payload.expires_in * 1000 }), { mode: 0o600 });
    return this.token;
  }

  async request(url, options = {}) {
    const token = await this.accessToken();
    const response = await this.fetch(url, { ...options, headers: { Accept: 'application/json', 'App-Version': APP_VERSION, Authorization: `Bearer ${token}`, BrandId: BRAND_ID, 'User-Agent': USER_AGENT, ...options.headers } });
    if (response.status === 401 || response.status === 403) {
      this.token = null;
      throw new Error(`MyQ returned HTTP ${response.status}; account authorization may have expired or been restricted`);
    }
    if (!response.ok) throw new Error(`MyQ request returned HTTP ${response.status}`);
    return response;
  }

  async getDoors() {
    const accounts = (await (await this.request(ENDPOINTS.accounts)).json()).accounts;
    if (!Array.isArray(accounts)) throw new Error('MyQ returned no account list');
    const result = [];
    for (const account of accounts) {
      const endpoint = `${ENDPOINTS.devices}/${encodeURIComponent(account.id)}/Devices`;
      const items = (await (await this.request(endpoint)).json()).items;
      if (!Array.isArray(items)) throw new Error('MyQ returned no device list');
      for (const item of items) {
        if (item.device_family === 'garagedoor' && item.serial_number) result.push({
          account_id: account.id,
          serial_number: item.serial_number,
          name: item.name || item.serial_number,
          state: item.state || {},
          online: typeof item.state?.online === 'boolean' ? item.state.online : null,
        });
      }
    }
    return result;
  }

  async command(door, action) {
    if (!['open', 'close'].includes(action)) throw new Error('Unsupported MyQ door command');
    const url = `${ENDPOINTS.doors}/${encodeURIComponent(door.account_id)}/door_openers/${encodeURIComponent(door.serial_number)}/${action}`;
    await this.request(url, { method: 'PUT' });
  }
}

function stateToCurrentDoorState(state, values) {
  const mapping = {
    open: values.OPEN,
    closed: values.CLOSED,
    opening: values.OPENING,
    closing: values.CLOSING,
    stopped: values.STOPPED,
    moving: values.OPENING,
  };
  return Object.hasOwn(mapping, state) ? mapping[state] : values.UNKNOWN;
}

module.exports = { MyQClient, stateToCurrentDoorState, ENDPOINTS };

