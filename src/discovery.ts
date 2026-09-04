import dgram, { type RemoteInfo, type Socket } from 'node:dgram';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import parserModule from 'tuyapi/lib/message-parser.js';
import type { DiscoveredDevice, PlugConfig } from './types.js';

const { MessageParser } = parserModule;
const UDP_KEY = createHash('md5').update('yGAdlopoPVldABfn').digest();
const VALID_VERSIONS = new Set(['3.1', '3.2', '3.3', '3.4', '3.5']);

export class TuyaLanDiscovery {
  async scan(timeoutSeconds = 15): Promise<DiscoveredDevice[]> {
    const found = new Map<string, DiscoveredDevice>();
    const sockets = [6666, 6667, 7000].map(port => this.listen(port, found));
    await Promise.all(sockets.map(({ ready }) => ready));
    const active = sockets.find(socket => socket.port === 7000)?.socket;
    if (active) {
      for (const target of broadcastTargets()) {
        try {
          active.send(createV35DiscoveryPacket(target.address), 7000, target.broadcast, () => undefined);
        } catch { /* passive discovery remains available */ }
      }
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(3, timeoutSeconds) * 1000));
    for (const { socket } of sockets) { try { socket.close(); } catch { /* already closed */ } }
    return [...found.values()];
  }

  private listen(port: number, found: Map<string, DiscoveredDevice>): { port: number; socket: Socket; ready: Promise<void> } {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (message, remote) => {
      const device = decodeDiscoveryPacket(message, remote);
      if (device) found.set(device.id, { ...found.get(device.id), ...device });
    });
    const ready = new Promise<void>(resolve => {
      const onBindError = (): void => resolve();
      socket.once('error', onBindError);
      socket.bind(port, '0.0.0.0', () => {
        socket.off('error', onBindError);
        socket.on('error', () => undefined);
        try { socket.setBroadcast(true); } catch { /* passive discovery remains available */ }
        resolve();
      });
    });
    return { port, socket, ready };
  }
}

export function decodeDiscoveryPacket(message: Buffer, remote: Pick<RemoteInfo, 'address'>): DiscoveredDevice | undefined {
  for (const version of ['3.3', '3.5']) {
    try {
      const packet = new MessageParser({ key: UDP_KEY, version }).parse(message)[0];
      const payload = packet?.payload;
      if (!payload || typeof payload !== 'object' || Buffer.isBuffer(payload)) continue;
      const data = payload as Record<string, unknown>;
      const id = stringValue(data.gwId) ?? stringValue(data.devId) ?? stringValue(data.id);
      if (!id) continue;
      const reportedVersion = stringValue(data.version);
      const validVersion = reportedVersion && VALID_VERSIONS.has(reportedVersion) ? reportedVersion as PlugConfig['version'] : undefined;
      return {
        id, ip: stringValue(data.ip) ?? remote.address, version: validVersion,
        productId: stringValue(data.productKey) ?? stringValue(data.productId),
      };
    } catch { /* try the other discovery framing */ }
  }
  return undefined;
}

export function createV35DiscoveryPacket(ip = '0.0.0.0'): Buffer {
  const raw = Buffer.from(JSON.stringify({ from: 'app', ip }));
  const prefix = Buffer.from([0x00, 0x00, 0x66, 0x99]);
  const header = Buffer.alloc(18);
  prefix.copy(header, 0);
  header.writeUInt32BE(1, 6);
  header.writeUInt32BE(0x25, 10);
  header.writeUInt32BE(12 + raw.length + 16, 14);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-128-gcm', UDP_KEY, iv);
  cipher.setAAD(header.subarray(4));
  const encrypted = Buffer.concat([cipher.update(raw), cipher.final()]);
  return Buffer.concat([header, iv, encrypted, cipher.getAuthTag(), Buffer.from([0x00, 0x00, 0x99, 0x66])]);
}

function stringValue(value: unknown): string | undefined { return typeof value === 'string' && value ? value : undefined; }

function broadcastTargets(): Array<{ address: string; broadcast: string }> {
  const targets: Array<{ address: string; broadcast: string }> = [];
  const seen = new Set<string>();
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      const address = entry.address.split('.').map(Number);
      const mask = entry.netmask.split('.').map(Number);
      if (address.length !== 4 || mask.length !== 4 || [...address, ...mask].some(Number.isNaN)) continue;
      const broadcast = address.map((octet, index) => (octet & mask[index]!) | (255 ^ mask[index]!)).join('.');
      const key = `${entry.address}/${broadcast}`;
      if (!seen.has(key)) {
        seen.add(key);
        targets.push({ address: entry.address, broadcast });
      }
    }
  }
  return targets.length ? targets : [{ address: '0.0.0.0', broadcast: '255.255.255.255' }];
}
