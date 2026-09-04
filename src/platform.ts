import type { API, Characteristic, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, Service } from 'homebridge';
import { BNETAAccessory } from './accessory.js';
import { TuyaCloudInventory } from './cloud.js';
import { TuyaLanDiscovery } from './discovery.js';
import { resolveDevices } from './resolver.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import type { BNETAPlatformConfig, CloudDevice, PlugConfig, PlugState } from './types.js';

export class BNETAPlatform implements DynamicPlatformPlugin {
  readonly Service: typeof Service;
  readonly Characteristic: typeof Characteristic;
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly cachedMatter = new Map<string, MatterAccessory>();
  private readonly handlers = new Map<string, BNETAAccessory>();
  private readonly reportedMatterState = new Map<string, { on?: boolean; power?: string; energy?: number }>();
  private readonly reportedMissingKeys = new Set<string>();
  private cloudDevices: CloudDevice[] = [];
  private discoveryTimer?: ReturnType<typeof setInterval>;
  private cloudTimer?: ReturnType<typeof setInterval>;
  private refreshing = false;
  private reportedMatterUnavailable = false;

  constructor(readonly log: Logging, private readonly config: BNETAPlatformConfig, readonly api: API) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    api.on('didFinishLaunching', () => void this.launch());
    api.on('shutdown', () => {
      this.handlers.forEach(handler => handler.stop());
      if (this.discoveryTimer) clearInterval(this.discoveryTimer);
      if (this.cloudTimer) clearInterval(this.cloudTimer);
    });
  }

  configureAccessory(accessory: PlatformAccessory): void { this.cached.set(accessory.UUID, accessory); }
  configureMatterAccessory(accessory: MatterAccessory): void { this.cachedMatter.set(accessory.UUID, accessory); }

  async updateMatter(device: PlugConfig, state: PlugState): Promise<void> {
    if (this.config.matter?.enabled === false || !this.api.matter) return;
    const uuid = this.uuid(device);
    const reported = { ...this.reportedMatterState.get(uuid) };
    try {
      if (reported.on !== state.on) {
        await this.api.matter.updateAccessoryState(uuid, this.api.matter.clusterNames.OnOff, { onOff: state.on });
        reported.on = state.on;
        this.reportedMatterState.set(uuid, reported);
      }
      if (this.config.matter?.electricalMeasurements !== false) {
        const electrical = matterElectricalState(state);
        const power = electrical.power;
        const powerKey = JSON.stringify(power);
        if (Object.keys(power).length && reported.power !== powerKey) {
          await this.api.matter.updateAccessoryState(
            uuid, this.api.matter.clusterNames.ElectricalPowerMeasurement, power,
          );
          reported.power = powerKey;
          this.reportedMatterState.set(uuid, reported);
        }
        if (electrical.energy && reported.energy !== electrical.energy.energy) {
          await this.api.matter.updateAccessoryState(
            uuid, this.api.matter.clusterNames.ElectricalEnergyMeasurement,
            { cumulativeEnergyImported: electrical.energy },
          );
          reported.energy = electrical.energy.energy;
          this.reportedMatterState.set(uuid, reported);
        }
      }
    } catch (error) { this.log.debug('%s Matter state update failed: %s', device.name, msg(error)); }
  }

  private async launch(): Promise<void> {
    await this.refreshCloud();
    await this.refreshDevices();
    if (this.config.discovery?.enabled !== false) {
      const seconds = Math.max(30, this.config.discovery?.refreshInterval ?? 300);
      this.discoveryTimer = setInterval(() => void this.refreshDevices(), seconds * 1000);
    }
    if (this.hasCloudConfig()) {
      const seconds = Math.max(300, this.config.cloud?.refreshInterval ?? 3600);
      this.cloudTimer = setInterval(async () => { await this.refreshCloud(); await this.refreshDevices(); }, seconds * 1000);
    }
  }

  private async refreshCloud(): Promise<void> {
    if (!this.hasCloudConfig()) return;
    try {
      this.cloudDevices = await new TuyaCloudInventory(this.config.cloud!).getDevices();
      this.log.info('Tuya Cloud returned %d associated devices; runtime control remains local.', this.cloudDevices.length);
    } catch (error) {
      this.log.warn('Tuya Cloud inventory failed; using manual keys and the last successful inventory: %s', msg(error));
    }
  }

  private async refreshDevices(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const discovered = this.config.discovery?.enabled === false ? [] :
        await new TuyaLanDiscovery().scan(this.config.discovery?.timeout ?? 15);
      if (this.config.discovery?.enabled !== false) this.log.info('LAN discovery found %d Tuya device(s).', discovered.length);
      const result = resolveDevices(
        this.config.devices ?? [], discovered, this.cloudDevices, this.config.discovery, this.config.defaultFeatures,
      );
      for (const missing of result.missingKeys) {
        if (!this.reportedMissingKeys.has(missing.id)) {
          this.reportedMissingKeys.add(missing.id);
          this.log.warn('Discovered Tuya device %s at %s but no 16-character local key is available.', missing.id, missing.ip);
        }
      }
      await this.syncDevices(result.devices);
    } catch (error) {
      this.log.warn('Tuya LAN discovery failed: %s', msg(error));
    } finally { this.refreshing = false; }
  }

  private async syncDevices(devices: PlugConfig[]): Promise<void> {
    const pendingStarts: BNETAAccessory[] = [];
    const live = new Set(devices.map(device => this.uuid(device)));
    const stale = [...this.cached.values()].filter(accessory =>
      this.config.discovery?.enabled === false ? !live.has(accessory.UUID) : this.isFiltered(accessory.context.deviceId),
    );
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const accessory of stale) {
        this.handlers.get(accessory.UUID)?.stop();
        this.handlers.delete(accessory.UUID);
        this.cached.delete(accessory.UUID);
        this.reportedMatterState.delete(accessory.UUID);
      }
    }

    for (const device of devices) {
      const uuid = this.uuid(device);
      const existingHandler = this.handlers.get(uuid);
      if (existingHandler && sameConfig(existingHandler.config, device)) continue;
      if (existingHandler) {
        this.log.info('%s network details changed; reconnecting with the refreshed discovery data.', device.name);
        existingHandler.stop();
        this.handlers.delete(uuid);
      }
      let accessory = this.cached.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.deviceId = device.id;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cached.set(uuid, accessory);
      }
      accessory.getService(this.Service.AccessoryInformation)!
        .setCharacteristic(this.Characteristic.Manufacturer, device.manufacturer ?? 'BNETA / Tuya')
        .setCharacteristic(this.Characteristic.Model, device.model ?? 'Wi-Fi Smart Plug')
        .setCharacteristic(this.Characteristic.SerialNumber, device.serialNumber ?? device.id);
      const handler = new BNETAAccessory(this, accessory, device);
      this.handlers.set(uuid, handler);
      pendingStarts.push(handler);
    }
    await this.syncMatter(devices);
    for (const handler of pendingStarts) void handler.start();
  }

  private async syncMatter(devices: PlugConfig[]): Promise<void> {
    const matter = this.api.matter;
    if (this.config.matter?.enabled === false) {
      const registered = [...this.cachedMatter.values()];
      if (matter && registered.length) await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, registered);
      this.cachedMatter.clear();
      this.reportedMatterState.clear();
      return;
    }
    if (!matter) {
      if (!this.reportedMatterUnavailable) {
        this.reportedMatterUnavailable = true;
        this.log.info('Matter is not enabled for this bridge; HAP/HomeKit remains active.');
      }
      return;
    }
    const wanted = new Set(devices.map(device => this.uuid(device)));
    const stale = [...this.cachedMatter.values()].filter(accessory =>
      this.config.discovery?.enabled === false ? !wanted.has(accessory.UUID) : this.isFiltered(accessory.context.deviceId),
    );
    if (stale.length) {
      await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      for (const accessory of stale) {
        this.cachedMatter.delete(accessory.UUID);
        this.reportedMatterState.delete(accessory.UUID);
      }
    }
    const wantsElectrical = this.config.matter?.electricalMeasurements !== false;
    const changedMatterShape = devices
      .map(device => this.cachedMatter.get(this.uuid(device)))
      .filter((accessory): accessory is MatterAccessory => Boolean(accessory))
      .filter(accessory => Boolean(accessory.clusters?.electricalPowerMeasurement) !== wantsElectrical);
    if (changedMatterShape.length) {
      await matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, changedMatterShape);
      for (const accessory of changedMatterShape) {
        this.cachedMatter.delete(accessory.UUID);
        this.reportedMatterState.delete(accessory.UUID);
      }
    }
    const fresh = devices.filter(device => !this.cachedMatter.has(this.uuid(device))).map(device => ({
      UUID: this.uuid(device), displayName: device.name,
      deviceType: matter.deviceTypes.OnOffOutlet,
      manufacturer: device.manufacturer ?? 'BNETA / Tuya', model: device.model ?? 'Wi-Fi Smart Plug',
      serialNumber: device.serialNumber ?? device.id, context: { deviceId: device.id },
      clusters: {
        onOff: { onOff: false },
        ...(this.config.matter?.electricalMeasurements !== false ? {
          electricalPowerMeasurement: { voltage: null, activeCurrent: null, activePower: null },
          electricalEnergyMeasurement: { cumulativeEnergyImported: null },
        } : {}),
      },
      handlers: { onOff: {
        on: async () => this.handlers.get(this.uuid(device))?.client.setOn(true),
        off: async () => this.handlers.get(this.uuid(device))?.client.setOn(false),
      } },
    }));
    if (fresh.length) {
      await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, fresh);
      for (const accessory of fresh) {
        this.cachedMatter.set(accessory.UUID, accessory);
        this.reportedMatterState.delete(accessory.UUID);
      }
    }
  }

  private uuid(device: PlugConfig): string { return this.api.hap.uuid.generate(`${PLUGIN_NAME}:${device.id}`); }
  private isFiltered(deviceId: unknown): boolean {
    if (typeof deviceId !== 'string') return false;
    const included = this.config.discovery?.includeDeviceIds ?? [];
    const excluded = this.config.discovery?.excludeDeviceIds ?? [];
    return excluded.includes(deviceId) || (included.length > 0 && !included.includes(deviceId));
  }
  private hasCloudConfig(): boolean {
    const cloud = this.config.cloud;
    if (!cloud || cloud.enabled === false) return false;
    if (cloud.accessId && cloud.accessSecret && cloud.region) return true;
    this.log.warn('Ignoring incomplete Tuya Cloud configuration; accessId, accessSecret, and region are all required.');
    return false;
  }
}

function msg(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function sameConfig(left: PlugConfig, right: PlugConfig): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export function matterElectricalState(state: PlugState): {
  power: { voltage?: number; activeCurrent?: number; activePower?: number };
  energy?: { energy: number };
} {
  const power: { voltage?: number; activeCurrent?: number; activePower?: number } = {};
  if (state.voltage !== undefined) power.voltage = Math.round(state.voltage * 1_000);
  if (state.current !== undefined) power.activeCurrent = Math.round(state.current * 1_000);
  if (state.power !== undefined) power.activePower = Math.round(state.power * 1_000);
  return {
    power,
    ...(state.energy !== undefined ? { energy: { energy: Math.round(state.energy * 1_000_000) } } : {}),
  };
}
