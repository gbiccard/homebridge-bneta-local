import type { Characteristic as HapCharacteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import type { BNETAPlatform } from './platform.js';
import type { PlugConfig, PlugState } from './types.js';
import { LocalTuyaPlug } from './tuya-client.js';

export class BNETAAccessory {
  readonly client: LocalTuyaPlug;
  private readonly outlet: Service;
  private current?: HapCharacteristic;
  private power?: HapCharacteristic;
  private voltage?: HapCharacteristic;
  private energy?: HapCharacteristic;
  private remainingDuration?: HapCharacteristic;
  private setDuration?: HapCharacteristic;
  private childLock?: HapCharacteristic;
  private statusFault?: HapCharacteristic;
  private state: PlugState = { on: false };

  constructor(private readonly platform: BNETAPlatform, private readonly accessory: PlatformAccessory, readonly config: PlugConfig) {
    const { Service, Characteristic } = platform;
    this.client = new LocalTuyaPlug(config, platform.log);
    this.outlet = accessory.getService(Service.Outlet) ?? accessory.addService(Service.Outlet);
    this.outlet.setCharacteristic(Characteristic.Name, config.name);
    this.outlet.getCharacteristic(Characteristic.On)
      .onGet(async () => (await this.client.getState()).on)
      .onSet(async (value: CharacteristicValue) => this.client.setOn(Boolean(value)));
    this.outlet.getCharacteristic(Characteristic.OutletInUse).onGet(async () => (await this.client.getState()).on);
    this.client.on('state', (state: PlugState) => this.update(state));
    this.client.on('unavailable', () => this.outlet.getCharacteristic(Characteristic.On).updateValue(new Error('BNETA plug unavailable')));
  }

  async start(): Promise<void> {
    try {
      await this.client.start();
      await this.client.getState();
      await this.client.applyConfiguredFeatures();
    } catch (error) { this.platform.log.warn('%s initial connection/configuration failed: %s', this.config.name, message(error)); }
  }
  stop(): void { this.client.stop(); }

  private addTelemetry(name: string, uuid: string, unit: string, minValue: number, maxValue: number): HapCharacteristic {
    const existing = this.outlet.characteristics.find(characteristic => characteristic.UUID === uuid);
    if (existing) return existing;
    const characteristic = new this.platform.Characteristic(name, uuid, {
      format: this.platform.api.hap.Formats.FLOAT,
      perms: [this.platform.api.hap.Perms.PAIRED_READ, this.platform.api.hap.Perms.NOTIFY],
      unit, minValue, maxValue, minStep: 0.001,
    });
    this.outlet.addCharacteristic(characteristic);
    return characteristic;
  }

  private update(next: PlugState): void {
    this.state = { ...this.state, ...withoutUndefined(next) };
    const { Characteristic } = this.platform;
    this.outlet.updateCharacteristic(Characteristic.On, this.state.on);
    this.outlet.updateCharacteristic(Characteristic.OutletInUse, this.state.on);
    if (this.state.current !== undefined) {
      this.current ??= this.addTelemetry('Electric Current', 'E863F126-079E-48FF-8F27-9C2605A29F52', 'A', 0, 100);
      this.current.updateValue(this.state.current);
    }
    if (this.state.power !== undefined) {
      this.power ??= this.addTelemetry('Current Consumption', 'E863F10D-079E-48FF-8F27-9C2605A29F52', 'W', 0, 100000);
      this.power.updateValue(this.state.power);
    }
    if (this.state.voltage !== undefined) {
      this.voltage ??= this.addTelemetry('Voltage', 'E863F10A-079E-48FF-8F27-9C2605A29F52', 'V', 0, 500);
      this.voltage.updateValue(this.state.voltage);
    }
    if (this.state.energy !== undefined) {
      this.energy ??= this.addTelemetry('Total Consumption', 'E863F10C-079E-48FF-8F27-9C2605A29F52', 'kWh', 0, 1_000_000);
      this.energy.updateValue(this.state.energy);
    }
    if (this.state.countdown !== undefined) {
      if (!this.remainingDuration) {
        this.outlet.addOptionalCharacteristic(Characteristic.RemainingDuration);
        this.outlet.addOptionalCharacteristic(Characteristic.SetDuration);
        this.remainingDuration = this.outlet.getCharacteristic(Characteristic.RemainingDuration)
          .onGet(async () => Math.min(3_600, (await this.client.getState()).countdown ?? 0));
        this.setDuration = this.outlet.getCharacteristic(Characteristic.SetDuration)
          .onGet(async () => Math.min(3_600, (await this.client.getState()).countdown ?? 0))
          .onSet(async value => this.client.setCountdown(Number(value)));
      }
      this.remainingDuration.updateValue(Math.min(3_600, this.state.countdown));
      this.setDuration?.updateValue(Math.min(3_600, this.state.countdown));
    }
    if (this.state.childLock !== undefined) {
      if (!this.childLock) {
        this.outlet.addOptionalCharacteristic(Characteristic.LockPhysicalControls);
        this.childLock = this.outlet.getCharacteristic(Characteristic.LockPhysicalControls)
          .onGet(async () => (await this.client.getState()).childLock ? 1 : 0)
          .onSet(async value => this.client.setChildLock(Number(value) === 1));
      }
      this.childLock.updateValue(this.state.childLock ? 1 : 0);
    }
    if (this.state.fault !== undefined) {
      if (!this.statusFault) {
        this.outlet.addOptionalCharacteristic(Characteristic.StatusFault);
        this.statusFault = this.outlet.getCharacteristic(Characteristic.StatusFault)
          .onGet(async () => (await this.client.getState()).fault ? 1 : 0);
      }
      this.statusFault.updateValue(this.state.fault ? 1 : 0);
    }
    void this.platform.updateMatter(this.config, this.state);
  }
}

function withoutUndefined(state: PlugState): Partial<PlugState> { return Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined)); }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
