import type { PlatformConfig } from 'homebridge';

export interface DpsMap {
  switch: number;
  countdown?: number;
  energy?: number;
  current?: number;
  power?: number;
  voltage?: number;
  fault?: number;
  powerOnState?: number;
  overchargeProtection?: number;
  indicatorMode?: number;
  childLock?: number;
  inching?: number;
  energyScale?: number;
  currentScale?: number;
  powerScale?: number;
  voltageScale?: number;
}

export type FeatureMode = 'unchanged' | 'enabled' | 'disabled';
export type PowerOnState = 'unchanged' | 'off' | 'on' | 'memory';
export type IndicatorMode = 'unchanged' | 'none' | 'on' | 'relay' | 'pos';

export interface DeviceFeaturesConfig {
  powerOnState?: PowerOnState;
  indicatorMode?: IndicatorMode;
  childLock?: FeatureMode;
  overchargeProtection?: FeatureMode;
  inching?: {
    mode?: FeatureMode;
    duration?: number;
    channel?: number;
  };
}

export interface PlugConfig {
  name: string;
  id: string;
  key: string;
  ip?: string;
  version?: '3.1' | '3.2' | '3.3' | '3.4' | '3.5';
  manufacturer?: string;
  model?: string;
  serialNumber?: string;
  dps?: Partial<DpsMap>;
  features?: DeviceFeaturesConfig;
  pollInterval?: number;
  retryInterval?: number;
}

export interface ConfiguredPlug extends Omit<PlugConfig, 'name' | 'key'> {
  name?: string;
  key?: string;
}

export type TuyaRegion = 'cn' | 'us' | 'us-e' | 'eu' | 'eu-w' | 'in' | 'sg';

export interface TuyaCloudConfig {
  enabled?: boolean;
  accessId: string;
  accessSecret: string;
  region: TuyaRegion;
  refreshInterval?: number;
}

export interface MatterConfig {
  enabled?: boolean;
  electricalMeasurements?: boolean;
}

export interface DiscoveryConfig {
  enabled?: boolean;
  timeout?: number;
  refreshInterval?: number;
  categories?: string[];
  includeDeviceIds?: string[];
  excludeDeviceIds?: string[];
  includeCloudDevicesNotSeenOnLan?: boolean;
}

export interface BNETAPlatformConfig extends PlatformConfig {
  platform: 'BNETALocal';
  name?: string;
  discovery?: DiscoveryConfig;
  cloud?: TuyaCloudConfig;
  matter?: MatterConfig;
  defaultFeatures?: DeviceFeaturesConfig;
  devices?: ConfiguredPlug[];
}

export interface PlugState {
  on: boolean;
  countdown?: number;
  energy?: number;
  current?: number;
  power?: number;
  voltage?: number;
  fault?: number;
  powerOnState?: Exclude<PowerOnState, 'unchanged'>;
  indicatorMode?: Exclude<IndicatorMode, 'unchanged'>;
  childLock?: boolean;
  overchargeProtection?: boolean;
  inchingEnabled?: boolean;
  inchingDuration?: number;
}

export interface DiscoveredDevice {
  id: string;
  ip: string;
  version?: PlugConfig['version'];
  productId?: string;
}

export interface CloudDevice {
  id: string;
  name?: string;
  localKey?: string;
  category?: string;
  productName?: string;
  model?: string;
  sub?: boolean;
}
