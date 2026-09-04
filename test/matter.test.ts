import assert from 'node:assert/strict';
import test from 'node:test';
import type { API, Logging, MatterAccessory } from 'homebridge';
import { BNETAPlatform, matterElectricalState } from '../src/platform.js';
import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';
import type { PlugConfig } from '../src/types.js';

test('converts plug readings into Matter electrical measurement units', () => {
  assert.deepEqual(matterElectricalState({
    on: true, voltage: 231.5, current: 0.125, power: 45.6, energy: 1.234,
  }), {
    power: { voltage: 231_500, activeCurrent: 125, activePower: 45_600 },
    energy: { energy: 1_234_000 },
  });
});

test('restores cached Matter command handlers without an unregister/register race', async () => {
  const registrations: MatterAccessory[][] = [];
  const unregistrations: MatterAccessory[][] = [];
  const states = new Map<string, Set<string>>();
  const clusterNames = {
    OnOff: 'onOff',
    ElectricalPowerMeasurement: 'electricalPowerMeasurement',
    ElectricalEnergyMeasurement: 'electricalEnergyMeasurement',
  };
  const matter = {
    clusterNames,
    deviceTypes: { OnOffOutlet: { name: 'OnOffOutlet' } },
    registerPlatformAccessories: async (plugin: string, platform: string, accessories: MatterAccessory[]) => {
      assert.equal(plugin, PLUGIN_NAME);
      assert.equal(platform, PLATFORM_NAME);
      registrations.push(accessories);
      setTimeout(() => {
        for (const accessory of accessories) {
          states.set(accessory.UUID, new Set(Object.keys(accessory.clusters ?? {})));
        }
      }, 10);
    },
    unregisterPlatformAccessories: async (_plugin: string, _platform: string, accessories: MatterAccessory[]) => {
      unregistrations.push(accessories);
    },
    getAccessoryState: async (uuid: string, cluster: string) =>
      states.get(uuid)?.has(cluster) ? {} : undefined,
  };
  const api = {
    hap: {
      Service: {}, Characteristic: {},
      uuid: { generate: (value: string) => value },
    },
    matter,
    on: () => undefined,
  } as unknown as API;
  const log = {
    info: () => undefined, warn: () => undefined, debug: () => undefined,
  } as unknown as Logging;
  const platform = new BNETAPlatform(log, {
    platform: PLATFORM_NAME,
    matter: { enabled: true, electricalMeasurements: true },
  }, api);
  const device: PlugConfig = { name: 'Test Plug', id: 'test-id', key: '0123456789abcdef' };
  const uuid = `${PLUGIN_NAME}:${device.id}`;

  // Homebridge restores the cached state, but functions cannot be serialized. This also
  // represents an older cache whose cluster shape must be upgraded in place.
  states.set(uuid, new Set([clusterNames.OnOff]));
  platform.configureMatterAccessory({
    UUID: uuid,
    displayName: device.name,
    deviceType: matter.deviceTypes.OnOffOutlet,
    manufacturer: 'BNETA',
    model: 'Test Plug',
    serialNumber: device.id,
    context: { deviceId: device.id },
    clusters: { onOff: { onOff: false } },
  } as unknown as MatterAccessory);

  const syncMatter = (platform as unknown as {
    syncMatter(devices: PlugConfig[]): Promise<void>;
  }).syncMatter.bind(platform);
  await syncMatter([device]);
  await syncMatter([device]);

  assert.equal(registrations.length, 1, 'the full definition is resubmitted once per process');
  assert.equal(unregistrations.length, 0, 'Homebridge owns ordered cache-shape migration');
  assert.equal(typeof registrations[0][0].handlers?.onOff?.on, 'function');
  assert.equal(typeof registrations[0][0].handlers?.onOff?.off, 'function');
  assert.ok(registrations[0][0].clusters?.electricalPowerMeasurement);
});
