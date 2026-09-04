import { createHash, createHmac } from 'node:crypto';
import type { CloudDevice, TuyaCloudConfig } from './types.js';

type FetchLike = typeof fetch;
interface TuyaResponse<T> { success: boolean; result?: T; code?: number; msg?: string }
interface TokenResult { access_token: string }
interface RawDevice {
  id?: string; name?: string; local_key?: string; category?: string;
  product_name?: string; model?: string; sub?: boolean; uid?: string;
}
interface DevicePage { devices?: RawDevice[]; list?: RawDevice[]; has_more?: boolean; last_row_key?: string }

const REGION_HOSTS: Record<TuyaCloudConfig['region'], string> = {
  cn: 'https://openapi.tuyacn.com',
  us: 'https://openapi.tuyaus.com',
  'us-e': 'https://openapi-ueaz.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  'eu-w': 'https://openapi-weaz.tuyaeu.com',
  in: 'https://openapi.tuyain.com',
  sg: 'https://openapi-sg.iotbing.com',
};

export class TuyaCloudInventory {
  private token?: string;

  constructor(
    private readonly config: TuyaCloudConfig,
    private readonly fetcher: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getDevices(): Promise<CloudDevice[]> {
    this.token = await this.getToken();
    const initial = await this.getAssociatedDevices();
    const byId = new Map(initial.map(device => [device.id, device]));
    const userIds = new Set(initial.map(device => device.uid).filter((uid): uid is string => Boolean(uid)));

    // The associated-device endpoint may omit local_key. Fetching the per-user
    // inventory fills it in for Smart Life/Tuya Smart linked accounts.
    for (const uid of userIds) {
      for (const device of await this.getUserDevices(uid)) {
        const existing = byId.get(device.id);
        byId.set(device.id, { ...existing, ...device, local_key: device.local_key || existing?.local_key });
      }
    }
    return [...byId.values()].filter(device => device.id).map(device => ({
      id: device.id!, name: device.name?.trim(), localKey: device.local_key,
      category: device.category, productName: device.product_name,
      model: device.model, sub: device.sub,
    }));
  }

  private async getToken(): Promise<string> {
    const response = await this.request<TokenResult>('/v1.0/token', { grant_type: '1' }, false);
    if (!response.access_token) throw new Error('Tuya token response did not contain an access token');
    return response.access_token;
  }

  private async getAssociatedDevices(): Promise<RawDevice[]> {
    const devices: RawDevice[] = [];
    let lastRowKey: string | undefined;
    do {
      const result = await this.request<DevicePage>('/v1.0/iot-01/associated-users/devices', {
        size: '50', ...(lastRowKey ? { last_row_key: lastRowKey } : {}),
      });
      devices.push(...(result.devices ?? result.list ?? []));
      lastRowKey = result.has_more ? result.last_row_key : undefined;
    } while (lastRowKey);
    return devices;
  }

  private async getUserDevices(uid: string): Promise<RawDevice[]> {
    const devices: RawDevice[] = [];
    let lastRowKey: string | undefined;
    do {
      const result = await this.request<DevicePage>('/v1.3/iot-03/devices', {
        page_size: '75', source_type: 'tuyaUser', source_id: uid,
        ...(lastRowKey ? { last_row_key: lastRowKey } : {}),
      });
      devices.push(...(result.list ?? result.devices ?? []));
      lastRowKey = result.has_more ? result.last_row_key : undefined;
    } while (lastRowKey);
    return devices;
  }

  private async request<T>(path: string, query: Record<string, string> = {}, authenticated = true): Promise<T> {
    const entries = Object.entries(query).sort(([a], [b]) => a.localeCompare(b));
    // Tuya signs the sorted, unescaped query string, while the HTTP request uses
    // normal URL encoding. Most IDs are URL-safe, but keeping these separate also
    // handles unusual source identifiers correctly.
    const signingQuery = entries.map(([key, value]) => `${key}=${value}`).join('&');
    const requestQuery = new URLSearchParams(entries).toString();
    const signingPath = `${path}${signingQuery ? `?${signingQuery}` : ''}`;
    const requestPath = `${path}${requestQuery ? `?${requestQuery}` : ''}`;
    const timestamp = String(this.now());
    const bodyHash = createHash('sha256').update('').digest('hex');
    const stringToSign = `GET\n${bodyHash}\n\n${signingPath}`;
    const signContent = `${this.config.accessId}${authenticated ? this.token ?? '' : ''}${timestamp}${stringToSign}`;
    const sign = createHmac('sha256', this.config.accessSecret).update(signContent).digest('hex').toUpperCase();
    const response = await this.fetcher(`${REGION_HOSTS[this.config.region]}${requestPath}`, {
      headers: {
        client_id: this.config.accessId, sign, t: timestamp, sign_method: 'HMAC-SHA256',
        ...(authenticated && this.token ? { access_token: this.token } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Tuya Cloud HTTP ${response.status} for ${path}`);
    const payload = await response.json() as TuyaResponse<T>;
    if (!payload.success || payload.result === undefined) {
      throw new Error(`Tuya Cloud ${payload.code ?? 'error'}: ${payload.msg ?? `request failed for ${path}`}`);
    }
    return payload.result;
  }
}
