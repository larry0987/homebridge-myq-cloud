'use strict';

const { MyQClient, stateToCurrentDoorState } = require('./myq-client');

const PLUGIN_NAME = 'homebridge-myq-cloud';
const PLATFORM_NAME = 'MyQCloud';
const COMMAND_POLL_INTERVALS_SECONDS = [1, 2, 3, 4, 5];
const COMMAND_MIN_TRACKING_MS = 30000;
const COMMAND_TRACKING_TIMEOUT_MS = 60000;

class MyQPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.api = api;
    this.config = config || {};
    this.accessories = new Map();
    this.client = null;
    this.timer = null;
    this.commandTrackers = new Map();
    this.commandPollStep = 0;
    this.consecutiveFailures = 0;
    this.lastSuccessfulPoll = null;
    this.lastFailureAt = null;
    if (!this.config.refreshToken) {
      this.log.error('MyQ requires an OAuth refreshToken. See the plugin README for setup.');
      return;
    }
    this.client = new MyQClient(this.config.refreshToken, api.user.storagePath(), log);
    api.on('didFinishLaunching', () => this.refresh().catch((error) => this.recordPollFailure(error)));
  }

  configureAccessory(accessory) { this.accessories.set(accessory.UUID, accessory); }

  async refresh() {
    if (!this.client) return;
    const pollStartedAt = Date.now();
    const doors = await this.client.getDoors();
    const found = new Set();
    for (const door of doors) {
      if (door.online === false && this.config.showOfflineDoors === false) continue;
      const uuid = this.api.hap.uuid.generate(`myq:${door.serial_number}`);
      found.add(uuid);
      let accessory = this.accessories.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(door.name || door.serial_number, uuid);
        accessory.context.serial = door.serial_number;
        accessory.context.accountId = door.account_id;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }
      accessory.context.door = door;
      this.bindDoor(accessory, door);
      this.updateAccessoryInformation(accessory, door);
      this.updateCharacteristics(accessory, door);
    }
    this.updateCommandTrackers(doors);
    for (const [uuid, accessory] of this.accessories) {
      if (!found.has(uuid)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
    const previousFailures = this.consecutiveFailures;
    const recoveredAt = Date.now();
    this.consecutiveFailures = 0;
    this.lastSuccessfulPoll = recoveredAt;
    if (previousFailures > 0) {
      this.log.info(`MyQ connection recovered after ${previousFailures} failed poll(s); discovered ${doors.length} garage door(s). Last failure was at ${new Date(this.lastFailureAt).toLocaleString()}; latest successful poll is ${new Date(recoveredAt).toLocaleString()}.`);
    } else if (!this.loggedInitialHealth) {
      this.loggedInitialHealth = true;
      this.log.info(`MyQ connection ready; discovered ${doors.length} garage door(s).`);
    }
    this.schedule();
  }

  recordPollFailure(error) {
    this.consecutiveFailures += 1;
    this.lastFailureAt = Date.now();
    const retryDelayMs = this.retryDelayMs(error);
    const lastSuccess = this.lastSuccessfulPoll
      ? ` Last successful poll: ${new Date(this.lastSuccessfulPoll).toLocaleString()}.`
      : ' No successful poll has completed yet.';
    this.log.warn(`MyQ polling failed (${error.message}). Retry ${this.consecutiveFailures} in ${Math.ceil(retryDelayMs / 1000)} seconds.${lastSuccess}`);
    this.scheduleRetry(retryDelayMs);
  }

  retryDelayMs(error) {
    const backoff = Math.min(30000 * (2 ** Math.min(this.consecutiveFailures - 1, 5)), 15 * 60 * 1000);
    return Math.max(error.retryAfterMs || 0, backoff);
  }

  bindDoor(accessory, door) {
    const { Service, Characteristic } = this.api.hap;
    const service = accessory.getService(Service.GarageDoorOpener) || accessory.addService(Service.GarageDoorOpener, door.name);
    service.getCharacteristic(Characteristic.CurrentDoorState).onGet(() => {
      const latest = accessory.context.door || door;
      if (latest.online === false) return Characteristic.CurrentDoorState.UNKNOWN;
      return stateToCurrentDoorState(latest.state?.door_state, Characteristic.CurrentDoorState);
    });
    service.getCharacteristic(Characteristic.TargetDoorState)
      .onGet(() => {
        const latest = accessory.context.door || door;
        return latest.state?.door_state === 'open' ? Characteristic.TargetDoorState.OPEN : Characteristic.TargetDoorState.CLOSED;
      })
      .onSet(async (target) => {
        const latest = accessory.context.door || door;
        if (latest.online === false) throw new Error('MyQ reports this opener offline');
        await this.client.command(latest, target === Characteristic.TargetDoorState.OPEN ? 'open' : 'close');
        const command = target === Characteristic.TargetDoorState.OPEN ? 'open' : 'close';
        this.log.info(`MyQ ${command} requested for ${latest.name}`);
        this.commandTrackers.set(latest.serial_number, {
          target: command,
          startedAt: Date.now(),
          confirmedAt: null,
        });
        this.commandPollStep = 0;
        this.schedule();
      });
    service.getCharacteristic(Characteristic.ObstructionDetected).onGet(() => false);
    accessory.displayName = door.name || door.serial_number;
  }

  updateAccessoryInformation(accessory, door) {
    const { Service, Characteristic } = this.api.hap;
    const info = accessory.getService(Service.AccessoryInformation)
      || accessory.addService(Service.AccessoryInformation);
    const modelParts = [door.model, door.model_number]
      .filter((value, index, values) => value && values.indexOf(value) === index);
    const values = [
      [Characteristic.Manufacturer, door.manufacturer || 'Unknown manufacturer'],
      [Characteristic.Model, modelParts.join(' / ') || 'Garage Door Opener'],
      // Do not use MyQ's internal device/account IDs as a substitute for the
      // physical serial. An explicit unavailable value is safer than a false one.
      [Characteristic.SerialNumber, door.hardware_serial_number || door.serial_number || 'Not reported by MyQ'],
      [Characteristic.FirmwareRevision, door.firmware || 'Not reported by MyQ'],
    ];
    for (const [characteristic, value] of values) {
      if (characteristic) info.getCharacteristic(characteristic).updateValue(value);
    }
  }

  updateCharacteristics(accessory, door) {
    const { Service, Characteristic } = this.api.hap;
    const service = accessory.getService(Service.GarageDoorOpener);
    if (!service) return;
    const current = door.online === false
      ? Characteristic.CurrentDoorState.UNKNOWN
      : stateToCurrentDoorState(door.state?.door_state, Characteristic.CurrentDoorState);
    const target = door.state?.door_state === 'open'
      ? Characteristic.TargetDoorState.OPEN
      : Characteristic.TargetDoorState.CLOSED;
    service.updateCharacteristic(Characteristic.CurrentDoorState, current);
    service.updateCharacteristic(Characteristic.TargetDoorState, target);
  }

  updateCommandTrackers(doors) {
    const now = Date.now();
    const doorsBySerial = new Map(doors.map((door) => [door.serial_number, door]));
    for (const [serial, tracker] of this.commandTrackers) {
      const door = doorsBySerial.get(serial);
      const targetState = tracker.target === 'open' ? 'open' : 'closed';
      if (door?.state?.door_state === targetState && tracker.confirmedAt === null) {
        tracker.confirmedAt = now;
      }
      if (shouldStopCommandTracking(tracker, now)) this.commandTrackers.delete(serial);
    }
    if (this.commandTrackers.size === 0) this.commandPollStep = 0;
  }

  schedule(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    let interval = delayMs;
    if (interval === undefined && this.commandTrackers.size > 0) {
      interval = commandPollIntervalSeconds(this.commandPollStep) * 1000;
      this.commandPollStep = Math.min(this.commandPollStep + 1, COMMAND_POLL_INTERVALS_SECONDS.length - 1);
    }
    if (interval === undefined) interval = Math.max(60, Number(this.config.pollIntervalSeconds) || 120) * 1000;
    this.timer = setTimeout(() => this.refresh().catch((error) => this.recordPollFailure(error)), interval);
    this.timer.unref?.();
  }

  scheduleRetry(delayMs = 240000) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh().catch((error) => this.recordPollFailure(error)), delayMs);
    this.timer.unref?.();
  }
}

function commandPollIntervalSeconds(step) {
  return COMMAND_POLL_INTERVALS_SECONDS[Math.min(Math.max(0, step), COMMAND_POLL_INTERVALS_SECONDS.length - 1)];
}

function shouldStopCommandTracking(tracker, now) {
  const elapsed = now - tracker.startedAt;
  return elapsed >= COMMAND_TRACKING_TIMEOUT_MS
    || (tracker.confirmedAt !== null && elapsed >= COMMAND_MIN_TRACKING_MS);
}

module.exports = (api) => api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MyQPlatform);
module.exports.MyQPlatform = MyQPlatform;
module.exports.PLUGIN_NAME = PLUGIN_NAME;
module.exports.commandPollIntervalSeconds = commandPollIntervalSeconds;
module.exports.shouldStopCommandTracking = shouldStopCommandTracking;

