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

// MyQ encodes the device brand and product class in characters 3–4 of many
// 12-character gateway/GDO serial numbers. This is used only as a fallback when
// the API doesn't return explicit manufacturer/model fields.
const SERIAL_HARDWARE_INFO = {
  '00': ['Chamberlain', 'Ethernet Gateway'],
  '01': ['LiftMaster', 'Ethernet Gateway'],
  '02': ['Craftsman', 'Ethernet Gateway'],
  '03': ['Chamberlain', 'Wi-Fi Hub'],
  '04': ['LiftMaster', 'Wi-Fi Hub'],
  '05': ['Craftsman', 'Wi-Fi Hub'],
  '08': ['LiftMaster', 'Wi-Fi Garage Door Opener (DC with battery backup)'],
  '09': ['Chamberlain', 'Wi-Fi Garage Door Opener (DC with battery backup)'],
  '0A': ['Chamberlain', 'Wi-Fi Garage Door Opener (AC)'],
  '0B': ['LiftMaster', 'Wi-Fi Garage Door Opener (AC)'],
  '0C': ['Craftsman', 'Wi-Fi Garage Door Opener (AC)'],
  '0D': ['myQ', 'Replacement Logic Board (AC)'],
  '0E': ['Chamberlain', 'Wi-Fi Garage Door Opener (AC, 3/4 HP)'],
  '0F': ['LiftMaster', 'Wi-Fi Garage Door Opener (AC, 3/4 HP)'],
  '10': ['Craftsman', 'Wi-Fi Garage Door Opener (AC, 3/4 HP)'],
  '11': ['myQ', 'Replacement Logic Board (AC, 3/4 HP)'],
  '12': ['Chamberlain', 'Wi-Fi Garage Door Opener (DC, 1.25 HP)'],
  '13': ['LiftMaster', 'Wi-Fi Garage Door Opener (DC, 1.25 HP)'],
  '14': ['Craftsman', 'Wi-Fi Garage Door Opener (DC, 1.25 HP)'],
  '15': ['myQ', 'Replacement Logic Board (DC, 1.25 HP)'],
  '20': ['Chamberlain', 'myQ Home Bridge'],
  '21': ['LiftMaster', 'myQ Home Bridge'],
  '23': ['Chamberlain', 'Smart Garage Hub'],
  '24': ['LiftMaster', 'Smart Garage Hub'],
  '27': ['LiftMaster', 'Wi-Fi Wall Mount Opener'],
  '28': ['LiftMaster Commercial', 'Wi-Fi Wall Mount Operator'],
  '33': ['Chamberlain', 'Smart Garage Control'],
  '34': ['LiftMaster', 'Smart Garage Control'],
  '80': ['LiftMaster EU', 'Ethernet Gateway'],
  '81': ['Chamberlain EU', 'Ethernet Gateway'],
};

function firstString(object, fields) {
  for (const field of fields) {
    const value = object?.[field];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function hardwareInfoFromSerial(serial) {
  if (typeof serial !== 'string' || !/^GW[A-Z0-9]{10}$/i.test(serial)) return null;
  const known = SERIAL_HARDWARE_INFO[serial.slice(2, 4).toUpperCase()];
  return known ? { manufacturer: known[0], model: known[1] } : null;
}

function deviceMetadata(item, parentHub = null) {
  // Keep the virtual garage-door serial for MyQ commands and accessory identity.
  const serialNumber = firstString(item, ['serial_number', 'serialNumber', 'hardware_serial_number', 'hardwareSerialNumber']);

  // Virtual garage doors identify their physical hardware through parent_device_id.
  const parentSerial = firstString(item, ['parent_device_id']);
  const hardwareSerial = parentSerial || serialNumber;
  const decoded = hardwareInfoFromSerial(hardwareSerial);

  const manufacturer =
    firstString(item, ['manufacturer', 'manufacturer_name', 'manufacturerName', 'brand'])
    || firstString(parentHub, ['manufacturer', 'manufacturer_name', 'manufacturerName', 'brand'])
    || decoded?.manufacturer
    || 'Unknown manufacturer';

  const model =
    firstString(item, ['model', 'model_name', 'modelName', 'product_name', 'productName'])
    || firstString(parentHub, ['model', 'model_name', 'modelName', 'product_name', 'productName'])
    || decoded?.model
    || firstString(item, ['device_model'])
    || 'Garage Door Opener';

  const modelNumber =
    firstString(item, ['model_number', 'modelNumber', 'device_model_number'])
    || firstString(parentHub, ['model_number', 'modelNumber', 'device_model_number']);

  const firmware =
    firstString(item, ['firmware_version', 'firmwareVersion', 'firmware', 'software_version', 'softwareVersion', 'sw_version'])
    || firstString(item.state, ['firmware_version', 'firmwareVersion', 'firmware', 'software_version', 'sw_version'])
    || firstString(parentHub, ['firmware_version', 'firmwareVersion', 'firmware', 'software_version', 'softwareVersion', 'sw_version'])
    || firstString(parentHub?.state, ['firmware_version', 'firmwareVersion', 'firmware', 'software_version', 'sw_version']);

  return {
    manufacturer,
    model,
    model_number: modelNumber,
    firmware,
    serial_number: serialNumber,
    hardware_serial_number: hardwareSerial,
  };
}

class MyQRequestError extends Error {
  constructor(message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'MyQRequestError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function retryAfterMilliseconds(response, now = Date.now()) {
  const value = response.headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : null;
}

function retryDelay(response, attempt) {
  const requested = retryAfterMilliseconds(response);
  if (requested !== null) return Math.min(requested, 15 * 60 * 1000);
  return Math.min(1000 * (2 ** attempt), 30000);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class MyQClient {
  constructor(refreshToken, storagePath, log = console, fetchImpl = fetch, sleepImpl = wait) {
    this.refreshToken = refreshToken;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
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
    if (!response.ok) {
      if (response.status === 429) {
        throw new MyQRequestError('MyQ token service rate limited the request', { status: response.status, retryAfterMs: retryAfterMilliseconds(response) });
      }
      if (response.status >= 500) throw new MyQRequestError(`MyQ token service returned HTTP ${response.status}`, { status: response.status, retryAfterMs: retryAfterMilliseconds(response) });
      throw new MyQRequestError(`MyQ token refresh returned HTTP ${response.status}; reauthorize the account and replace refreshToken`, { status: response.status });
    }
    if (!payload.access_token || typeof payload.expires_in !== 'number') throw new Error('MyQ token refresh response was incomplete');
    this.token = payload.access_token;
    if (payload.refresh_token) this.refreshToken = payload.refresh_token;
    await fs.mkdir(path.dirname(this.tokenPath), { recursive: true });
    await fs.writeFile(this.tokenPath, JSON.stringify({ accessToken: this.token, refreshToken: this.refreshToken, expiresAt: Date.now() + payload.expires_in * 1000 }), { mode: 0o600 });
    return this.token;
  }

  async request(url, options = {}) {
    const token = await this.accessToken();
    const requestOptions = { ...options, headers: { Accept: 'application/json', 'App-Version': APP_VERSION, Authorization: `Bearer ${token}`, BrandId: BRAND_ID, 'User-Agent': USER_AGENT, ...options.headers } };
    const canRetry = (options.method || 'GET').toUpperCase() === 'GET';
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await this.fetch(url, requestOptions);
      } catch (error) {
        if (!canRetry || attempt >= 2) throw new MyQRequestError(`MyQ network request failed: ${error.message}`);
        await this.sleep(Math.min(1000 * (2 ** attempt), 30000));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        this.token = null;
        throw new MyQRequestError(`MyQ returned HTTP ${response.status}; account authorization may have expired or been restricted`, { status: response.status });
      }
      if ((response.status === 429 || response.status >= 500) && canRetry && attempt < 2) {
        await this.sleep(retryDelay(response, attempt));
        continue;
      }
      if (!response.ok) {
        const retryAfterMs = retryAfterMilliseconds(response);
        throw new MyQRequestError(`MyQ request returned HTTP ${response.status}${response.status === 429 ? '; rate limit reached' : ''}`, { status: response.status, retryAfterMs });
      }
      return response;
    }
  }

  async getDoors() {
    const accounts = (await (await this.request(ENDPOINTS.accounts)).json()).accounts;
    if (!Array.isArray(accounts)) throw new Error('MyQ returned no account list');
    const result = [];
    for (const account of accounts) {
      const endpoint = `${ENDPOINTS.devices}/${encodeURIComponent(account.id)}/Devices`;
      const items = (await (await this.request(endpoint)).json()).items;
      if (!Array.isArray(items)) throw new Error('MyQ returned no device list');
      // Resolve parent hubs from this account's inventory before mapping virtual doors.
      const devicesBySerial = new Map(
        items
          .map((item) => [firstString(item, ['serial_number', 'serialNumber']), item])
          .filter(([serial]) => serial)
      );

      for (const item of items) {
        const parentHub = devicesBySerial.get(firstString(item, ['parent_device_id'])) || null;
        const metadata = deviceMetadata(item, parentHub);
        if (item.device_family === 'garagedoor' && metadata.serial_number) result.push({
          account_id: account.id,
          ...metadata,
          name: firstString(item, ['name']) || metadata.serial_number,
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

module.exports = { MyQClient, MyQRequestError, retryAfterMilliseconds, stateToCurrentDoorState, deviceMetadata, hardwareInfoFromSerial, ENDPOINTS };

