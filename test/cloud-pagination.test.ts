import assert from 'node:assert/strict';
import test from 'node:test';
import { TuyaCloudInventory } from '../src/cloud.js';

test('follows Tuya inventory pagination for associated and per-user devices', async () => {
  const urls: string[] = [];
  const responses = [
    { success: true, result: { access_token: 'token' } },
    { success: true, result: { devices: [{ id: 'plug-one', uid: 'user-one' }], has_more: true, last_row_key: 'next users' } },
    { success: true, result: { devices: [{ id: 'plug-two', uid: 'user-one' }], has_more: false } },
    { success: true, result: { list: [{ id: 'plug-one', local_key: '0123456789abcdef' }], has_more: true, last_row_key: 'next devices' } },
    { success: true, result: { list: [{ id: 'plug-two', local_key: 'fedcba9876543210' }], has_more: false } },
  ];
  const fetcher = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const inventory = new TuyaCloudInventory({ accessId: 'client', accessSecret: 'secret', region: 'eu' }, fetcher, () => 1700000000000);
  const devices = await inventory.getDevices();

  assert.deepEqual(devices.map(device => [device.id, device.localKey]), [
    ['plug-one', '0123456789abcdef'],
    ['plug-two', 'fedcba9876543210'],
  ]);
  assert.match(urls[2]!, /last_row_key=next\+users/);
  assert.match(urls[4]!, /last_row_key=next\+devices/);
});
