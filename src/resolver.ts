import type { CloudDevice, ConfiguredPlug, DeviceFeaturesConfig, DiscoveryConfig, DiscoveredDevice, PlugConfig } from './types.js';

export interface ResolveResult { devices: PlugConfig[]; missingKeys: DiscoveredDevice[]; filtered: string[] }

export function resolveDevices(
  configured: ConfiguredPlug[], discovered: DiscoveredDevice[], cloud: CloudDevice[], discovery: DiscoveryConfig = {},
  defaultFeatures?: DeviceFeaturesConfig,
): ResolveResult {
  const configuredById = new Map(configured.filter(device => device?.id).map(device => [device.id, device]));
  const discoveredById = new Map(discovered.map(device => [device.id, device]));
  const cloudById = new Map(cloud.map(device => [device.id, device]));
  const candidates = new Set<string>(configuredById.keys());
  for (const device of discovered) candidates.add(device.id);
  if (discovery.includeCloudDevicesNotSeenOnLan) for (const device of cloud) candidates.add(device.id);

  const categories = new Set(discovery.categories?.length ? discovery.categories : ['cz', 'pc']);
  const included = new Set(discovery.includeDeviceIds ?? []);
  const excluded = new Set(discovery.excludeDeviceIds ?? []);
  const devices: PlugConfig[] = [];
  const missingKeys: DiscoveredDevice[] = [];
  const filtered: string[] = [];

  for (const id of candidates) {
    const manual = configuredById.get(id);
    const lan = discoveredById.get(id);
    const remote = cloudById.get(id);
    if (excluded.has(id) || (included.size && !included.has(id))) { filtered.push(id); continue; }
    if (!manual && remote?.category && !categories.has(remote.category)) { filtered.push(id); continue; }
    if (!manual && remote?.sub) { filtered.push(id); continue; }
    const key = manual?.key || remote?.localKey;
    if (!key || key.length !== 16) { if (lan) missingKeys.push(lan); continue; }
    const features = mergeFeatures(defaultFeatures, manual?.features);
    devices.push({
      ...manual,
      id, key,
      name: manual?.name || remote?.name || remote?.productName || `Tuya Plug ${id.slice(-4)}`,
      ip: manual?.ip || lan?.ip,
      version: manual?.version || lan?.version || '3.3',
      manufacturer: manual?.manufacturer || 'BNETA / Tuya',
      model: manual?.model || remote?.model || remote?.productName || 'Wi-Fi Smart Plug',
      ...(features ? { features } : {}),
    });
  }
  return { devices, missingKeys, filtered };
}

function mergeFeatures(defaults?: DeviceFeaturesConfig, overrides?: DeviceFeaturesConfig): DeviceFeaturesConfig | undefined {
  if (!defaults && !overrides) return undefined;
  return {
    ...defaults,
    ...overrides,
    ...((defaults?.inching || overrides?.inching) ? { inching: { ...defaults?.inching, ...overrides?.inching } } : {}),
  };
}
