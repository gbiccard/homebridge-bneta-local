import assert from 'node:assert/strict';
import test from 'node:test';
import { matterElectricalState } from '../src/platform.js';

test('converts plug readings into Matter electrical measurement units', () => {
  assert.deepEqual(matterElectricalState({
    on: true, voltage: 231.5, current: 0.125, power: 45.6, energy: 1.234,
  }), {
    power: { voltage: 231_500, activeCurrent: 125, activePower: 45_600 },
    energy: { energy: 1_234_000 },
  });
});
