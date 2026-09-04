import assert from 'node:assert/strict';
import { createDecipheriv, createHash } from 'node:crypto';
import test from 'node:test';
import { createV35DiscoveryPacket } from '../src/discovery.js';

test('builds a correctly framed Tuya 3.5 active-discovery packet', () => {
  const packet = createV35DiscoveryPacket('192.168.1.10');
  assert.equal(packet.readUInt32BE(0), 0x00006699);
  assert.equal(packet.readUInt32BE(10), 0x25);
  assert.equal(packet.readUInt32BE(14), packet.length - 22);
  assert.equal(packet.readUInt32BE(packet.length - 4), 0x00009966);

  const key = createHash('md5').update('yGAdlopoPVldABfn').digest();
  const decipher = createDecipheriv('aes-128-gcm', key, packet.subarray(18, 30));
  decipher.setAAD(packet.subarray(4, 18));
  decipher.setAuthTag(packet.subarray(packet.length - 20, packet.length - 4));
  const clear = Buffer.concat([decipher.update(packet.subarray(30, packet.length - 20)), decipher.final()]);
  assert.deepEqual(JSON.parse(clear.toString()), { from: 'app', ip: '192.168.1.10' });
});
