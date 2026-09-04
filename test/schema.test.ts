import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Homebridge graphical schema exposes every plugin configuration section', () => {
  const schema = JSON.parse(readFileSync('config.schema.json', 'utf8')) as Record<string, unknown>;
  const serialized = JSON.stringify(schema);

  assert.equal(schema.pluginAlias, 'BNETALocal');
  assert.equal(schema.pluginType, 'platform');
  for (const path of [
    'cloud.enabled', 'cloud.accessId', 'cloud.accessSecret', 'cloud.region',
    'discovery.enabled', 'discovery.categories', 'matter.enabled', 'matter.electricalMeasurements',
    'defaultFeatures.inching.mode', 'defaultFeatures.inching.duration',
    'devices[].id', 'devices[].key', 'devices[].ip', 'devices[].features.inching.mode',
    'devices[].dps.switch', 'devices[].dps.countdown', 'devices[].dps.energy', 'devices[].dps.inching',
  ]) assert.match(serialized, new RegExp(path.replaceAll('.', '\\.').replaceAll('[]', '\\[\\]')));
  assert.match(serialized, /"type":"password"/);
  assert.match(serialized, /"type":"tabarray"/);
});
