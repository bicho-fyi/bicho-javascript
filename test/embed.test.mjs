import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'vitest';

const bundle = () => readFileSync(new URL('../dist/bicho.min.js', import.meta.url), 'utf8');
function load(dataset) {
  const requests = [];
  const sandbox = {
    TextEncoder, URL, crypto, AbortController, setTimeout, clearTimeout,
    window: new EventTarget(),
    document: { currentScript: dataset === undefined ? null : { dataset } },
    fetch: async (url, options) => { requests.push({ url, ...options }); return new Response('{}'); },
  };
  vm.runInNewContext(bundle(), sandbox);
  return { sdk: sandbox.Bicho, requests, sandbox };
}

test('script attributes initialize the standalone SDK with custom data', async () => {
  const { sdk, requests, sandbox } = load({
    endpoint: 'https://collector.invalid/v1/logs', key: 'public-key', environment: 'test', release: 'app@1', serviceName: 'checkout',
    tags: '{"app":"checkout"}', contexts: '{"checkout":{"stage":"payment"}}', autoCapture: 'false',
  });
  try {
    assert.ok(sdk.captureMessage('embedded'));
    assert.equal(await sdk.flush(), true);
    const resource = JSON.parse(requests[0].body).resourceLogs[0];
    const attrs = Object.fromEntries(resource.scopeLogs[0].logRecords[0].attributes.map(item => [item.key, item.value.stringValue]));
    const resources = Object.fromEntries(resource.resource.attributes.map(item => [item.key, item.value.stringValue]));
    assert.equal(requests[0].url, 'https://collector.invalid/v1/logs');
    assert.equal(resources['deployment.environment.name'], 'test');
    assert.equal(resources['service.name'], 'checkout');
    assert.equal(requests[0].headers['X-Bicho-Key'], 'public-key');
    assert.equal(resources['service.version'], 'app@1');
    assert.equal(attrs.app, 'checkout');
    assert.equal(JSON.parse(attrs['bicho.contexts']).checkout.stage, 'payment');
    const error = Object.assign(new globalThis.Event('error'), { error: new Error('disabled') });
    sandbox.window.dispatchEvent(error);
    assert.equal(requests.length, 1);
  } finally { await sdk.close(0); }
});

test('plain script supports explicit initialization and import without a document', async () => {
  for (const dataset of [undefined, {}]) {
    const { sdk } = load(dataset);
    assert.equal(sdk.captureMessage('not initialized'), undefined);
    sdk.init({ endpoint: 'https://collector.invalid/v1/logs', key: 'public-key' });
    assert.ok(sdk.captureMessage('manual'));
    assert.equal(await sdk.close(), true);
  }
});

test('invalid embed attributes fail before enabling collection', () => {
  for (const dataset of [
    { endpoint: 'https://user:password@collector.invalid/v1/logs', key: 'public-key' },
    { endpoint: 'https://collector.invalid/v1/logs' },
    { key: 'public-key' },
    { endpoint: 'https://collector.invalid/v1/logs', key: 'public-key', tags: 'broken' },
    { endpoint: 'https://collector.invalid/v1/logs', key: 'public-key', contexts: '[]' },
    { endpoint: 'https://collector.invalid/v1/logs', key: 'public-key', autoCapture: 'no' },
  ]) assert.throws(() => load(dataset), /Bicho|JSON/);
});
