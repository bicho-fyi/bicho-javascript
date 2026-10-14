import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, test } from 'vitest';
import * as Bicho from '../dist/index.js';

const endpoint = 'https://collector.invalid/v1/logs';
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const clients = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close(0)));
  await Bicho.close(0);
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

test('backend requests reject redirects without forwarding the ingest key', async () => {
  delete globalThis.window;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return new Response(null, { status: 302, headers: { Location: 'https://other.invalid/v1/logs' } });
  };
  const client = Bicho.createClient({ endpoint, key: 'backend-key' });
  clients.push(client);
  client.captureMessage('redirect');
  assert.equal(await client.close(), false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].redirect, 'manual');
});

test('Node fetch delivers OTLP to a loopback HTTP collector', async () => {
  delete globalThis.window;
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = { path: request.url, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const client = Bicho.createClient({ endpoint: `http://127.0.0.1:${server.address().port}/v1/logs`, key: 'backend-key', serviceName: 'worker/api' });
    clients.push(client);
    const id = client.captureException(new Error('local transport'));
    assert.equal(await client.close(5000), true);
    assert.equal(received.path, '/v1/logs');
    assert.equal(received.headers['x-bicho-key'], 'backend-key');
    const resource = received.body.resourceLogs[0];
    assert.equal(resource.resource.attributes.find(item => item.key === 'service.name').value.stringValue, 'worker/api');
    assert.equal(resource.scopeLogs[0].logRecords[0].attributes.find(item => item.key === 'log.record.uid').value.stringValue, id);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('isolated clients keep concurrent request context and shutdown separate', async () => {
  delete globalThis.window;
  const requests = [];
  const releases = [];
  globalThis.fetch = (url, options) => {
    requests.push({ url, ...options });
    return new Promise(resolve => releases.push(() => resolve(new Response('{}'))));
  };
  assert.equal(typeof Bicho.createClient, 'function');
  const first = Bicho.createClient({ endpoint, key: 'first-key', contexts: { request: { route: '/first' } } });
  const second = Bicho.createClient({ endpoint, key: 'second-key', contexts: { request: { route: '/second' } } });
  clients.push(first, second);
  first.captureMessage('first');
  second.captureMessage('second');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers['X-Bicho-Key'], 'first-key');
  assert.equal(requests[1].headers['X-Bicho-Key'], 'second-key');
  assert.ok(!requests[0].body.includes('/second'));
  assert.ok(!requests[1].body.includes('/first'));
  assert.equal(await first.close(0), false);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);
  releases.forEach(release => release());
  assert.equal(await second.flush(), true);
  assert.ok(second.captureMessage('still open'));
  releases.at(-1)();
  assert.equal(await second.close(), true);
  assert.equal(first.captureMessage('closed'), undefined);
});

test('manual server capture works without window or process listeners', async () => {
  delete globalThis.window;
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url, ...options }); return new Response('{}'); };
  const listeners = [process.listenerCount('uncaughtException'), process.listenerCount('unhandledRejection')];
  Bicho.init({ endpoint, key: 'backend-key' });
  const error = new TypeError('backend failed');
  const id = Bicho.captureException(error, { contexts: { request: { route: '/api/test', authorization: 'private' } } });
  assert.ok(id);
  assert.equal(await Bicho.close(), true);
  assert.equal(requests.length, 1);
  const resource = JSON.parse(requests[0].body).resourceLogs[0];
  const attrs = Object.fromEntries(resource.scopeLogs[0].logRecords[0].attributes.map(item => [item.key, item.value.stringValue]));
  assert.equal(attrs['exception.type'], 'TypeError');
  assert.equal(attrs['exception.stacktrace'], error.stack);
  assert.equal(attrs['log.record.uid'], id);
  assert.equal(resource.resource.attributes.find(item => item.key === 'service.name').value.stringValue, 'app/backend');
  assert.equal(resource.scopeLogs[0].scope.name, 'bicho.javascript');
  assert.ok(!requests[0].body.includes('private'));
  assert.deepEqual([process.listenerCount('uncaughtException'), process.listenerCount('unhandledRejection')], listeners);
});
