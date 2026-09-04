import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDevices } from '../src/resolver.js';

test('joins LAN discovery with cloud names, categories, and local keys', () => {
  const result = resolveDevices(
    [],
    [{ id: 'plug-one', ip: '192.168.1.50', version: '3.4' }],
    [{ id: 'plug-one', name: 'Desk Plug', localKey: '0123456789abcdef', category: 'cz', model: 'IN02' }],
  );
  assert.deepEqual(result.devices, [{
    id: 'plug-one', key: '0123456789abcdef', name: 'Desk Plug', ip: '192.168.1.50', version: '3.4',
    manufacturer: 'BNETA / Tuya', model: 'IN02',
  }]);
});

test('filters cloud-classified non-outlet devices', () => {
  const result = resolveDevices(
    [],
    [{ id: 'bulb-one', ip: '192.168.1.51', version: '3.3' }],
    [{ id: 'bulb-one', name: 'Lamp', localKey: '0123456789abcdef', category: 'dj' }],
  );
  assert.equal(result.devices.length, 0);
  assert.deepEqual(result.filtered, ['bulb-one']);
});

test('supports manual local-key fallback and records keyless discoveries', () => {
  const result = resolveDevices(
    [{ id: 'manual-one', key: 'fedcba9876543210', name: 'Manual Plug' }],
    [{ id: 'manual-one', ip: '192.168.1.52' }, { id: 'unknown', ip: '192.168.1.53' }],
    [],
  );
  assert.equal(result.devices[0].ip, '192.168.1.52');
  assert.equal(result.devices[0].version, '3.3');
  assert.deepEqual(result.missingKeys, [{ id: 'unknown', ip: '192.168.1.53' }]);
});

test('merges default device features with per-plug overrides', () => {
  const result = resolveDevices(
    [{ id: 'manual-one', key: 'fedcba9876543210', features: { childLock: 'disabled', inching: { duration: 5 } } }],
    [{ id: 'manual-one', ip: '192.168.1.52' }],
    [], {},
    { childLock: 'enabled', powerOnState: 'memory', inching: { mode: 'enabled', duration: 2, channel: 0 } },
  );
  assert.deepEqual(result.devices[0].features, {
    childLock: 'disabled', powerOnState: 'memory', inching: { mode: 'enabled', duration: 5, channel: 0 },
  });
});
