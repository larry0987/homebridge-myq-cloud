'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MyQClient, stateToCurrentDoorState, ENDPOINTS } = require('../src/myq-client');
const { commandPollIntervalSeconds, shouldStopCommandTracking } = require('../src/index');

test('uses short polling intervals after a door command, then caps at five seconds', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(commandPollIntervalSeconds), [1, 2, 3, 4, 5, 5, 5]);
});

test('keeps command tracking for at least 30 seconds and times out at 60 seconds', () => {
  const startedAt = 1000;
  const confirmed = { startedAt, confirmedAt: 1500 };
  const waiting = { startedAt, confirmedAt: null };
  assert.equal(shouldStopCommandTracking(confirmed, startedAt + 29999), false);
  assert.equal(shouldStopCommandTracking(confirmed, startedAt + 30000), true);
  assert.equal(shouldStopCommandTracking(waiting, startedAt + 59999), false);
  assert.equal(shouldStopCommandTracking(waiting, startedAt + 60000), true);
});

test('maps MyQ movement and unknown states to HomeKit', () => {
  const values = { OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3, STOPPED: 4, UNKNOWN: 99 };
  assert.equal(stateToCurrentDoorState('opening', values), 2);
  assert.equal(stateToCurrentDoorState('closed', values), 1);
  assert.equal(stateToCurrentDoorState('not-a-state', values), 99);
});

test('uses current MyQ v6 residential service endpoints', () => {
  assert.match(ENDPOINTS.accounts, /accounts\.myq-cloud\.com\/api\/v6\.0\/accounts$/);
  assert.match(ENDPOINTS.devices, /devices\.myq-cloud\.com\/api\/v6\.2\/Accounts$/);
  assert.match(ENDPOINTS.doors, /account-devices-gdo\.myq-cloud\.com\/api\/v6\.0\/accounts$/);
});

test('discovers garage doors and sends the documented open command', async () => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'myq-plugin-'));
  await fs.writeFile(path.join(storage, 'myq-cloud-token.json'), JSON.stringify({ accessToken: 'access', refreshToken: 'rotated', expiresAt: Date.now() + 3600000 }));
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === ENDPOINTS.accounts) return Response.json({ accounts: [{ id: 'acct-1' }] });
    if (String(url).endsWith('/acct-1/Devices')) return Response.json({ items: [{ device_family: 'garagedoor', serial_number: 'door-1', name: 'Garage', state: { door_state: 'closed', online: true } }, { device_family: 'camera', serial_number: 'camera-1' }] });
    return new Response(null, { status: 204 });
  };
  try {
    const client = new MyQClient('configured', storage, { warn() {} }, fakeFetch);
    const doors = await client.getDoors();
    assert.equal(doors.length, 1);
    assert.equal(doors[0].name, 'Garage');
    await client.command(doors[0], 'open');
    assert.equal(calls.at(-1).options.method, 'PUT');
    assert.match(calls.at(-1).url, /door_openers\/door-1\/open$/);
    assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer access');
  } finally {
    await fs.rm(storage, { recursive: true, force: true });
  }
});

