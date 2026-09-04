import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { decodeInching, encodeInching, LocalTuyaPlug, upsertInching } from '../src/tuya-client.js';

class FakeTuya extends EventEmitter {
  connected = true;
  sets: unknown[] = [];
  response: object = { dps: { '1': true, '18': 125, '19': 456, '20': 2315 } };
  isConnected(): boolean { return this.connected; }
  async find(): Promise<boolean> { return true; }
  async connect(): Promise<void> { this.connected = true; }
  disconnect(): void { this.connected = false; }
  async get(): Promise<object> { return this.response; }
  async set(options: unknown): Promise<object> { this.sets.push(options); return {}; }
}

const log = { debug() {}, info() {}, warn() {}, error() {}, success() {}, log() {} };

test('maps and scales common BNETA energy DPS values', () => {
  const plug = new LocalTuyaPlug({ name: 'Test', id: 'id', key: 'key', dps: { current: 18, power: 19, voltage: 20 } }, log as never, new FakeTuya() as never);
  const state = plug.parse({ dps: { '1': true, '17': 1234, '18': 125, '19': 456, '20': 2315 } });
  assert.deepEqual({ on: state.on, energy: state.energy, current: state.current, power: state.power, voltage: state.voltage },
    { on: true, energy: 1.234, current: 0.125, power: 45.6, voltage: 231.5 });
  plug.stop();
});

test('honours custom DPS mappings and scales', () => {
  const plug = new LocalTuyaPlug({ name: 'Test', id: 'id', key: 'key', dps: { switch: 20, power: 7, powerScale: 1 } }, log as never, new FakeTuya() as never);
  const state = plug.parse({ dps: { '20': true, '7': 88 } });
  assert.deepEqual({ on: state.on, current: state.current, power: state.power, voltage: state.voltage },
    { on: true, current: undefined, power: 88, voltage: undefined });
  plug.stop();
});

test('encodes and decodes Tuya device-managed inching frames', () => {
  assert.equal(encodeInching(true, 300), 'AQEs');
  assert.deepEqual(decodeInching('AQEs'), { enabled: true, duration: 300 });
  assert.equal(encodeInching(false, 2), 'AAAC');
  assert.deepEqual(decodeInching(encodeInching(true, 65_535, 3), 3), { enabled: true, duration: 65_535 });
  const twoChannels = upsertInching(encodeInching(true, 10, 0), true, 20, 1);
  assert.deepEqual(decodeInching(twoChannels, 0), { enabled: true, duration: 10 });
  assert.deepEqual(decodeInching(twoChannels, 1), { enabled: true, duration: 20 });
  assert.deepEqual(decodeInching(upsertInching(twoChannels, false, 30, 0), 0), { enabled: false, duration: 30 });
});

test('programs supported persistent socket features and device-managed inching in one command', async () => {
  const device = new FakeTuya();
  device.response = { dps: {
    '1': false, '9': 0, '17': 250, '18': 0, '19': 0, '20': 2300, '26': 0,
    '38': 'off', '39': false, '40': 'none', '41': false, '44': 'AAAC',
  } };
  const plug = new LocalTuyaPlug({
    name: 'Test', id: 'id', key: 'key',
    features: {
      powerOnState: 'memory', indicatorMode: 'relay', childLock: 'enabled', overchargeProtection: 'enabled',
      inching: { mode: 'enabled', duration: 300, channel: 0 },
    },
  }, log as never, device as never);

  await plug.getState();
  await plug.applyConfiguredFeatures();
  assert.deepEqual(device.sets[0], { multiple: true, data: {
    '38': 'memory', '39': true, '40': 'relay', '41': true, '44': 'AQEs',
  } });
  plug.stop();
});

test('does not rewrite persistent feature settings that already match the device', async () => {
  const device = new FakeTuya();
  device.response = { dps: {
    '1': false, '38': 'memory', '39': true, '40': 'relay', '41': true, '44': 'AQEs',
  } };
  const plug = new LocalTuyaPlug({
    name: 'Test', id: 'id', key: 'key',
    features: {
      powerOnState: 'memory', indicatorMode: 'relay', childLock: 'enabled', overchargeProtection: 'enabled',
      inching: { mode: 'enabled', duration: 300, channel: 0 },
    },
  }, log as never, device as never);

  await plug.getState();
  await plug.applyConfiguredFeatures();
  assert.equal(device.sets.length, 0);
  plug.stop();
});

test('auto-detects alternate high-power plug telemetry and feature DPS', () => {
  const plug = new LocalTuyaPlug({ name: 'Test', id: 'id', key: 'key' }, log as never, new FakeTuya() as never);
  const state = plug.parse({ dps: {
    '1': true, '7': 120, '14': 'last', '15': 'relay', '19': 'AQEs',
    '20': 1234, '21': 500, '22': 1250, '23': 2305, '29': 0,
  } });
  assert.deepEqual({
    countdown: state.countdown, energy: state.energy, current: state.current, power: state.power, voltage: state.voltage,
    powerOnState: state.powerOnState, indicatorMode: state.indicatorMode,
    inchingEnabled: state.inchingEnabled, inchingDuration: state.inchingDuration,
  }, {
    countdown: 120, energy: 1.234, current: 0.5, power: 125, voltage: 230.5,
    powerOnState: 'memory', indicatorMode: 'relay', inchingEnabled: true, inchingDuration: 300,
  });
  plug.stop();
});
