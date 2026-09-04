import assert from 'node:assert/strict';
import test from 'node:test';
import { TuyaCloudInventory } from '../src/cloud.js';

test('authenticates, fetches associated devices, and fills local keys from user inventory', async () => {
  const calls: Array<{ url: string; headers: HeadersInit }> = [];
  const responses = [
    { success: true, result: { access_token: 'token' } },
    { success: true, result: { devices: [{ id: 'plug-one', name: 'Plug', uid: 'user-one', category: 'cz' }] } },
    { success: true, result: { list: [{ id: 'plug-one', local_key: '0123456789abcdef', model: 'IN02' }] } },
  ];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const cloud = new TuyaCloudInventory({ accessId: 'client', accessSecret: 'secret', region: 'eu' }, fetcher, () => 1700000000000);
  assert.deepEqual(await cloud.getDevices(), [{
    id: 'plug-one', name: 'Plug', localKey: '0123456789abcdef', category: 'cz',
    productName: undefined, model: 'IN02', sub: undefined,
  }]);
  assert.match(calls[0].url, /\/v1\.0\/token\?grant_type=1$/);
  assert.match(calls[2].url, /\/v1\.3\/iot-03\/devices\?page_size=75&source_id=user-one&source_type=tuyaUser$/);
  assert.equal((calls[1].headers as Record<string, string>).access_token, 'token');
  assert.match((calls[0].headers as Record<string, string>).sign, /^[A-F0-9]{64}$/);
});
