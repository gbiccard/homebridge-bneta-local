import { EventEmitter } from 'node:events';
import TuyAPI from 'tuyapi';
import type { Logging } from 'homebridge';
import type { DpsMap, PlugConfig, PlugState } from './types.js';

type DpsPayload = { dps?: Record<string, unknown> } | Record<string, unknown> | boolean;
type Timer = ReturnType<typeof setTimeout>;
type WritableDpsValue = string | number | boolean;

const DEFAULT_DPS: DpsMap = {
  switch: 1, countdown: 9, energy: 17, current: 18, power: 19, voltage: 20,
  fault: 26, powerOnState: 38, overchargeProtection: 39, indicatorMode: 40,
  childLock: 41, inching: 44,
  energyScale: 1000, currentScale: 1000, powerScale: 10, voltageScale: 10,
};

export class LocalTuyaPlug extends EventEmitter {
  private readonly device: TuyAPI;
  private readonly map: DpsMap;
  private readonly detectSwitchDps: boolean;
  private readonly detectTelemetryDps: boolean;
  private readonly detectedDps = new Set<number>();
  private reconnectTimer?: Timer;
  private pollTimer?: Timer;
  private stopped = false;
  private connecting?: Promise<void>;
  private failures = 0;
  private lastState: PlugState = { on: false };
  private powerOnDialect: 'standard' | 'legacy' = 'standard';
  private rawInching?: string;

  constructor(private readonly config: PlugConfig, private readonly log: Logging, device?: TuyAPI) {
    super();
    this.map = { ...DEFAULT_DPS, ...config.dps };
    this.detectSwitchDps = config.dps?.switch === undefined;
    this.detectTelemetryDps = config.dps?.current === undefined && config.dps?.power === undefined && config.dps?.voltage === undefined;
    this.device = device ?? new TuyAPI({ id: config.id, key: config.key, ip: config.ip, version: config.version ?? '3.3' });
    this.device.on('connected', () => { this.failures = 0; this.log.debug('%s connected', config.name); });
    this.device.on('disconnected', () => this.scheduleReconnect('connection closed'));
    this.device.on('error', (error: Error) => this.handleError(error));
    this.device.on('data', (data: DpsPayload) => this.publish(data));
    this.device.on('dp-refresh', (data: DpsPayload) => this.publish(data));
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.ensureConnected();
    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    try { this.device.disconnect(); } catch { /* already disconnected */ }
  }

  async getState(): Promise<PlugState> {
    await this.ensureConnected();
    const payload = await this.device.get({ schema: true }) as DpsPayload;
    const state = this.parse(payload);
    this.recordState(state);
    return state;
  }

  async setOn(on: boolean): Promise<void> {
    await this.ensureConnected();
    await this.device.set({ dps: this.map.switch, set: on });
    this.recordState({ ...this.lastState, on });
  }

  async setCountdown(seconds: number): Promise<void> {
    const dps = this.requireDps(this.map.countdown, 'countdown');
    const value = Math.max(0, Math.min(86_400, Math.round(seconds)));
    await this.setDps(dps, value);
    this.recordState({ ...this.lastState, countdown: value });
  }

  async setChildLock(enabled: boolean): Promise<void> {
    const dps = this.requireDps(this.map.childLock, 'child lock');
    await this.setDps(dps, enabled);
    this.recordState({ ...this.lastState, childLock: enabled });
  }

  async applyConfiguredFeatures(): Promise<void> {
    const features = this.config.features;
    if (!features) return;
    const writes: Record<string, WritableDpsValue> = {};

    if (features.powerOnState && features.powerOnState !== 'unchanged' && features.powerOnState !== this.lastState.powerOnState) {
      const raw = this.powerOnDialect === 'legacy' ?
        ({ off: 'power_off', on: 'power_on', memory: 'last' } as const)[features.powerOnState] : features.powerOnState;
      this.addWrite(writes, this.map.powerOnState, raw, 'power-on state');
    }
    if (features.indicatorMode && features.indicatorMode !== 'unchanged' && features.indicatorMode !== this.lastState.indicatorMode) {
      this.addWrite(writes, this.map.indicatorMode, features.indicatorMode, 'indicator mode');
    }
    if (features.childLock && features.childLock !== 'unchanged' &&
      (features.childLock === 'enabled') !== this.lastState.childLock) {
      this.addWrite(writes, this.map.childLock, features.childLock === 'enabled', 'child lock');
    }
    if (features.overchargeProtection && features.overchargeProtection !== 'unchanged' &&
      (features.overchargeProtection === 'enabled') !== this.lastState.overchargeProtection) {
      this.addWrite(writes, this.map.overchargeProtection, features.overchargeProtection === 'enabled', 'overcharge protection');
    }
    const inching = features.inching;
    if (inching?.mode && inching.mode !== 'unchanged') {
      const duration = inching.duration ?? this.lastState.inchingDuration ?? 1;
      const enabled = inching.mode === 'enabled';
      if (enabled !== this.lastState.inchingEnabled || duration !== this.lastState.inchingDuration) {
        this.addWrite(writes, this.map.inching, upsertInching(this.rawInching, enabled, duration, inching.channel ?? 0), 'inching');
      }
    }
    if (!Object.keys(writes).length) return;
    await this.ensureConnected();
    await this.device.set({ multiple: true, data: writes });
    await this.getState();
  }

  parse(payload: DpsPayload): PlugState {
    const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
    const dps = ('dps' in record && typeof record.dps === 'object' && record.dps !== null ? record.dps : record) as Record<string, unknown>;
    for (const id of Object.keys(dps).map(Number).filter(Number.isInteger)) this.detectedDps.add(id);
    if (this.detectSwitchDps && typeof dps[String(this.map.switch)] !== 'boolean' && typeof dps['20'] === 'boolean') {
      this.map.switch = 20;
      this.log.info('%s detected on/off DPS 20', this.config.name);
    }
    if (this.detectTelemetryDps && typeof dps['19'] !== 'number') {
      if (typeof dps['5'] === 'number') {
        this.map.current = 4; this.map.power = 5; this.map.voltage = 6;
      } else if (typeof dps['22'] === 'number' && typeof dps['23'] === 'number') {
        this.map.energy = 20; this.map.current = 21; this.map.power = 22; this.map.voltage = 23;
      }
    }
    if (typeof dps[String(this.map.countdown)] !== 'number') {
      if (typeof dps['2'] === 'number') this.map.countdown = 2;
      else if (typeof dps['7'] === 'number') this.map.countdown = 7;
    }
    if (typeof dps[String(this.map.fault)] !== 'number' && typeof dps['29'] === 'number') this.map.fault = 29;
    const rawPowerOn = dps[String(this.map.powerOnState)];
    if (typeof rawPowerOn !== 'string' && typeof dps['14'] === 'string') this.map.powerOnState = 14;
    const detectedPowerOn = dps[String(this.map.powerOnState)];
    if (detectedPowerOn === 'power_off' || detectedPowerOn === 'power_on' || detectedPowerOn === 'last') this.powerOnDialect = 'legacy';
    if (typeof dps[String(this.map.indicatorMode)] !== 'string' && typeof dps['15'] === 'string') this.map.indicatorMode = 15;
    if (typeof dps[String(this.map.inching)] !== 'string' && typeof dps['19'] === 'string') this.map.inching = 19;
    const rawInching = dps[String(this.map.inching)];
    if (typeof rawInching === 'string') this.rawInching = rawInching;
    const inching = decodeInching(rawInching, this.config.features?.inching?.channel ?? 0);
    const switchValue = dps[String(this.map.switch)];
    return {
      on: typeof switchValue === 'boolean' ? switchValue : this.lastState.on,
      countdown: numberValue(dps[String(this.map.countdown)]),
      energy: this.scaled(dps, this.map.energy, this.map.energyScale),
      current: this.scaled(dps, this.map.current, this.map.currentScale),
      power: this.scaled(dps, this.map.power, this.map.powerScale),
      voltage: this.scaled(dps, this.map.voltage, this.map.voltageScale),
      fault: numberValue(dps[String(this.map.fault)]),
      powerOnState: normalizePowerOnState(detectedPowerOn),
      indicatorMode: indicatorMode(dps[String(this.map.indicatorMode)]),
      childLock: booleanValue(dps[String(this.map.childLock)]),
      overchargeProtection: booleanValue(dps[String(this.map.overchargeProtection)]),
      inchingEnabled: inching?.enabled,
      inchingDuration: inching?.duration,
    };
  }

  private scaled(dps: Record<string, unknown>, id?: number, scale = 1): number | undefined {
    if (id === undefined || typeof dps[String(id)] !== 'number') return undefined;
    return Number(dps[String(id)]) / scale;
  }

  private async setDps(dps: number, value: WritableDpsValue): Promise<void> {
    await this.ensureConnected();
    await this.device.set({ dps, set: value });
  }

  private requireDps(dps: number | undefined, label: string): number {
    if (dps === undefined || !this.detectedDps.has(dps)) throw new Error(`${this.config.name} does not advertise a ${label} DPS`);
    return dps;
  }

  private addWrite(writes: Record<string, WritableDpsValue>, dps: number | undefined, value: WritableDpsValue, label: string): void {
    if (dps !== undefined && this.detectedDps.has(dps)) writes[String(dps)] = value;
    else this.log.warn('%s does not advertise a %s DPS; leaving that device setting unchanged.', this.config.name, label);
  }

  private async ensureConnected(): Promise<void> {
    if (this.device.isConnected()) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      if (!this.config.ip) await this.device.find({ timeout: 10 });
      await this.device.connect();
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    const seconds = Math.max(5, this.config.pollInterval ?? 30);
    this.pollTimer = setTimeout(async () => {
      try { await this.getState(); } catch (error) { this.handleError(error); }
      this.schedulePoll();
    }, seconds * 1000);
    this.pollTimer.unref?.();
  }

  private handleError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.log.warn('%s local Tuya error: %s', this.config.name, message);
    this.emit('unavailable', error);
    this.scheduleReconnect(message);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.failures += 1;
    const base = Math.max(2, this.config.retryInterval ?? 5) * 1000;
    const delay = Math.min(60_000, base * 2 ** Math.min(this.failures - 1, 4));
    this.log.debug('%s reconnecting in %dms (%s)', this.config.name, delay, reason);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try { await this.ensureConnected(); await this.getState(); } catch (error) { this.handleError(error); }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private publish(payload: DpsPayload): void { this.recordState(this.parse(payload)); }
  private recordState(state: PlugState): void {
    this.lastState = { ...this.lastState, ...withoutUndefined(state) };
    this.emit('state', this.lastState);
  }
}

export function encodeInching(enabled: boolean, duration: number, channel = 0): string {
  if (!Number.isInteger(channel) || channel < 0 || channel > 127) throw new RangeError('Inching channel must be between 0 and 127');
  const seconds = Math.max(1, Math.min(65_535, Math.round(duration)));
  const data = Buffer.alloc(3);
  data[0] = (channel << 1) | (enabled ? 1 : 0);
  data.writeUInt16BE(seconds, 1);
  return data.toString('base64');
}

export function decodeInching(value: unknown, channel = 0): { enabled: boolean; duration: number } | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const data = Buffer.from(value, 'base64');
  for (let offset = 0; offset + 2 < data.length; offset += 3) {
    if (data[offset]! >> 1 === channel) return { enabled: Boolean(data[offset]! & 1), duration: data.readUInt16BE(offset + 1) };
  }
  return undefined;
}

export function upsertInching(value: unknown, enabled: boolean, duration: number, channel = 0): string {
  const tuple = Buffer.from(encodeInching(enabled, duration, channel), 'base64');
  if (typeof value !== 'string' || !value) return tuple.toString('base64');
  const current = Buffer.from(value, 'base64');
  if (!current.length || current.length % 3 !== 0) return tuple.toString('base64');
  const result: Buffer[] = [];
  let replaced = false;
  for (let offset = 0; offset < current.length; offset += 3) {
    const existing = current.subarray(offset, offset + 3);
    if (existing[0]! >> 1 === channel) {
      if (!replaced) result.push(tuple);
      replaced = true;
    } else result.push(existing);
  }
  if (!replaced) result.push(tuple);
  return Buffer.concat(result).toString('base64');
}

function booleanValue(value: unknown): boolean | undefined { return typeof value === 'boolean' ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' ? value : undefined; }
function normalizePowerOnState(value: unknown): PlugState['powerOnState'] {
  if (value === 'off' || value === 'power_off') return 'off';
  if (value === 'on' || value === 'power_on') return 'on';
  if (value === 'memory' || value === 'last') return 'memory';
  return undefined;
}
function indicatorMode(value: unknown): PlugState['indicatorMode'] {
  return value === 'none' || value === 'on' || value === 'relay' || value === 'pos' ? value : undefined;
}
function withoutUndefined(state: PlugState): Partial<PlugState> {
  return Object.fromEntries(Object.entries(state).filter(([, value]) => value !== undefined));
}
