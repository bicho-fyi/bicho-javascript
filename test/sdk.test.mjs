import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import * as Bicho from '../dist/index.js';

const endpoint = 'https://collector.invalid/v1/logs';
const key = 'public-key';
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
let requests = [];

function setup(options = {}, respond = () => new Response('{}')) {
  requests = [];
  globalThis.window = new EventTarget();
  globalThis.fetch = async (url, options) => {
    requests.push({ url, ...options });
    return respond(requests.length, options);
  };
  Bicho.init({ endpoint, key, ...options });
}

function wire(index = 0) { return JSON.parse(requests[index].body); }
function attributes(items) { return Object.fromEntries(items.map(({ key, value }) => [key, value.stringValue ?? value.boolValue ?? value.intValue ?? value.doubleValue])); }
function event(index = 0) {
  const resource = wire(index).resourceLogs[0];
  const record = resource.scopeLogs[0].logRecords[0];
  const attrs = attributes(record.attributes);
  const resources = attributes(resource.resource.attributes);
  return {
    event_id: attrs['log.record.uid'], message: record.body.stringValue,
    environment: resources['deployment.environment.name'], release: resources['service.version'],
    tags: attrs, contexts: attrs['bicho.contexts'] ? JSON.parse(attrs['bicho.contexts']) : {},
    exception: { type: attrs['exception.type'], message: attrs['exception.message'], stacktrace: attrs['exception.stacktrace'] },
  };
}

afterEach(async () => {
  await Bicho.close(0);
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
});

test('OTLP JSON, identity, metadata and public-key transport', async () => {
  setup({ environment: 'test', release: 'web@1' });
  const id = Bicho.captureMessage('café\n猫');
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.notEqual(Bicho.captureMessage('next'), id);
  assert.equal(await Bicho.flush(), true);
  assert.equal(event().event_id, id);
  assert.equal(event().message, 'café\n猫');
  assert.equal(event().environment, 'test');
  assert.equal(event().release, 'web@1');
  assert.equal(requests[0].url, endpoint);
  assert.equal(requests[0].credentials, 'omit');
  assert.equal(requests[0].referrerPolicy, 'no-referrer');
  assert.equal(requests[0].redirect, 'error');
  assert.equal(requests[0].headers['X-Bicho-Key'], key);
  assert.equal(requests[0].headers['Content-Type'], 'application/json');
  const resource = wire().resourceLogs[0];
  assert.equal(attributes(resource.resource.attributes)['service.name'], 'app/browser');
  assert.deepEqual(resource.scopeLogs[0].scope, { name: 'bicho.javascript.browser', version: '1.1.0' });
  assert.equal(resource.scopeLogs[0].logRecords[0].severityNumber, 17);
  assert.match(resource.scopeLogs[0].logRecords[0].timeUnixNano, /^\d+$/);
  assert.equal(event().request, undefined);
});

test('rejects malformed endpoints and keys without replacing an initialized client', async () => {
  setup();
  for (const invalid of ['https://user:pass@collector.invalid/v1/logs', 'https://collector.invalid/v1/logs?q=1', 'https://collector.invalid/v1/logs#x', ' https://collector.invalid/v1/logs', 'https://collector.invalid/a/../v1/logs', 'https://collector.invalid/v1/logs/', 'http://collector.invalid/v1/logs', 'https://collector.invalid/other']) {
    assert.throws(() => Bicho.init({ endpoint: invalid, key }), /endpoint/);
  }
  for (const invalid of ['', 'x'.repeat(129), 'secret key', 'key\n', 'key:secret']) assert.throws(() => Bicho.init({ endpoint, key: invalid }), /key/);
  assert.ok(Bicho.captureMessage('still active'));
  assert.equal(await Bicho.flush(), true);
  await Bicho.close();
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    setup({ endpoint: `http://${host}/v1/logs` });
    assert.ok(Bicho.captureMessage('local'));
    assert.equal(await Bicho.close(), true);
  }
});

test('Chrome, Firefox and Safari raw stacks retain coordinates without URL credentials', async () => {
  setup();
  const stacks = [
    'Error: broken\n    at fail (https://u:p@app.invalid/app.js?token=private#x:20:8)\n    at https://app.invalid/main.js:5:2',
    'fail@https://app.invalid/app.js?token=private#x:20:8\n@https://app.invalid/main.js:5:2',
  ];
  for (const stack of stacks) {
    const error = new Error('broken');
    error.stack = stack;
    Bicho.captureException(error);
  }
  assert.equal(await Bicho.flush(), true);
  for (let i = 0; i < stacks.length; i++) {
    assert.equal(event(i).exception.type, 'Error');
    assert.equal(event(i).exception.message, 'broken');
    assert.ok(event(i).exception.stacktrace.includes('https://app.invalid/app.js:20:8'));
    assert.ok(event(i).exception.stacktrace.includes('https://app.invalid/main.js:5:2'));
    assert.ok(!event(i).exception.stacktrace.includes('private'));
    assert.ok(!event(i).exception.stacktrace.includes('u:p@'));
  }
});

test('privacy hook, recursive capture, hostile thrown values and structured data', async () => {
  setup({ beforeSend(value) {
    assert.equal(Bicho.captureMessage('recursive'), undefined);
    value.message = value.message?.replace('private', 'redacted');
    return value.message === 'drop' ? null : value;
  } });
  const context = { password: 'hidden', count: 1n };
  context.self = context;
  Object.defineProperty(context, 'getter', { enumerable: true, get() { throw new Error('getter called'); } });
  Bicho.captureMessage('private', { tags: { token: 'hidden', section: 'checkout' }, contexts: { debug: context } });
  assert.equal(Bicho.captureMessage('drop'), undefined);
  for (const value of [undefined, null, 1n, Symbol('x'), context, new Proxy({}, { get() { throw 1; }, ownKeys() { throw 1; } })]) {
    assert.doesNotThrow(() => Bicho.captureException(value));
  }
  assert.equal(await Bicho.flush(), true);
  const payload = event();
  assert.equal(payload.message, 'redacted');
  assert.equal(payload.tags.token, '[Filtered]');
  assert.equal(payload.contexts.debug.password, '[Filtered]');
  assert.equal(payload.contexts.debug.count, '1');
  assert.equal(payload.contexts.debug.self, '[Circular]');
  assert.equal(payload.contexts.debug.getter, '[Accessor]');
  assert.ok(!requests.some(request => request.body.includes('hidden')));
});

test('global errors and rejections do not suppress browser handlers; close removes listeners', async () => {
  setup();
  const target = globalThis.window;
  const error = new Event('error', { cancelable: true });
  Object.assign(error, { error: new Error('global') });
  const rejection = new Event('unhandledrejection', { cancelable: true });
  Object.assign(rejection, { reason: 'rejected' });
  target.dispatchEvent(error);
  target.dispatchEvent(rejection);
  assert.equal(error.defaultPrevented, false);
  assert.equal(rejection.defaultPrevented, false);
  assert.equal(await Bicho.close(), true);
  assert.equal(requests.length, 2);
  assert.equal(event().exception.message, 'global');
  assert.equal(event(1).exception.message, 'rejected');
  target.dispatchEvent(error);
  assert.equal(Bicho.captureMessage('closed'), undefined);
  assert.equal(requests.length, 2);
});

test('stable retry payload and FIFO, no self reporting on network failure', async () => {
  setup({}, count => { if (count === 1) throw new TypeError('network'); return new Response('{}'); });
  const id = Bicho.captureException(new Error('retry'));
  Bicho.captureMessage('after');
  assert.equal(await Bicho.flush(5000), true);
  assert.equal(requests.length, 3);
  assert.equal(event(0).event_id, id);
  assert.equal(event(1).event_id, id);
  assert.equal(event(2).message, 'after');
  assert.equal(requests[0].body, requests[1].body);
});

test('queue is bounded, flush times out, close aborts and disables capture', async () => {
  setup({}, (_count, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  for (let i = 0; i < 30; i++) assert.ok(Bicho.captureMessage(String(i)));
  assert.equal(Bicho.captureMessage('overflow'), undefined);
  assert.equal(await Bicho.flush(1), false);
  assert.equal(await Bicho.close(1), false);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(Bicho.captureMessage('closed'), undefined);
});

test('429 honors seconds, dates and fallback without shortening long delays', async () => {
  for (const headers of [{ 'Retry-After': '60' }, { 'Retry-After': new Date(Date.now() + 60000).toUTCString() }, {}]) {
    await Bicho.close(0);
    setup({}, () => new Response('{}', { status: 429, headers }));
    Bicho.captureMessage('limited');
    assert.equal(await Bicho.flush(), false);
    assert.equal(Bicho.captureMessage('blocked'), undefined);
    assert.equal(requests.length, 1);
  }
});

test('short 429 retries respect Retry-After and preserve queued FIFO payloads', async () => {
  setup({}, count => new Response('{}', count === 1 ? { status: 429, headers: { 'Retry-After': '0.05' } } : {}));
  Bicho.captureMessage('one');
  Bicho.captureMessage('two');
  assert.equal(await Bicho.flush(5000), true);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(event(2).message, 'two');
});

test('permanent errors are not retried and retries are bounded', async () => {
  setup({}, () => new Response('{}', { status: 403 }));
  Bicho.captureMessage('forbidden');
  assert.equal(await Bicho.flush(), false);
  assert.equal(requests.length, 1);
  await Bicho.close(0);
  setup({}, () => new Response('{}', { status: 503 }));
  Bicho.captureMessage('unavailable');
  assert.equal(await Bicho.flush(5000), false);
  assert.equal(requests.length, 3);
});

test('long Retry-After is not shortened to fit the retry budget', async () => {
  setup({}, () => new Response('{}', { status: 503, headers: { 'Retry-After': '120' } }));
  Bicho.captureMessage('unavailable');
  assert.equal(await Bicho.flush(), false);
  assert.equal(requests.length, 1);
});

test('hooks cannot replace event identity, add user data or bypass the payload cap', async () => {
  setup({ beforeSend(value) {
    value.event_id = 'wrong';
    value.user = { email: 'private@example.invalid' };
    value.request = { url: 'https://private.invalid/' };
    return value;
  } });
  const id = Bicho.captureMessage('message');
  await Bicho.flush();
  assert.equal(event().event_id, id);
  assert.equal(event().user, undefined);
  assert.equal(event().request, undefined);
  assert.equal(Bicho.captureMessage('x'.repeat(16384), {
    tags: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`tag${i}`, 'x'.repeat(512)])),
  }), undefined);
  assert.equal(requests.length, 1);
});

test('closing from beforeSend cannot enqueue an event after shutdown', async () => {
  let closed;
  setup({ beforeSend(value) { closed = Bicho.close(); return value; } });
  assert.equal(Bicho.captureMessage('drop'), undefined);
  assert.equal(await closed, true);
  assert.equal(requests.length, 0);
});

test('resource errors are ignored and automatic handlers can be disabled', async () => {
  setup({ autoCapture: false });
  globalThis.window.dispatchEvent(Object.assign(new Event('error'), { error: new Error('ignored') }));
  assert.equal(requests.length, 0);
  await Bicho.close();
  setup();
  globalThis.window.dispatchEvent(new Event('error'));
  assert.equal(requests.length, 0);
});

test('reinitialization requires close; throwing or asynchronous hooks cannot leak rejections', async () => {
  setup({ beforeSend() { throw new Error('hook failed'); } });
  assert.throws(() => Bicho.init({ endpoint, key }), /close/);
  assert.equal(Bicho.captureMessage('drop'), undefined);
  await Bicho.close(0);
  setup({ beforeSend: async () => { throw new Error('async unsupported'); } });
  assert.equal(Bicho.captureMessage('drop'), undefined);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests.length, 0);
});

test('OTLP partial success is terminal and rejected records fail flush', async () => {
  for (const [response, expected] of [
    [{ partialSuccess: { rejectedLogRecords: '1', errorMessage: 'rejected' } }, false],
    [{ partialSuccess: { rejectedLogRecords: 1 } }, false],
    [{ partialSuccess: { rejectedLogRecords: '0', errorMessage: 'warning' } }, true],
    [{ partialSuccess: {} }, true],
  ]) {
    await Bicho.close(0);
    setup({}, () => new Response(JSON.stringify(response)));
    Bicho.captureMessage('partial');
    assert.equal(await Bicho.flush(), expected);
    assert.equal(requests.length, 1);
  }
});

test('HTTP 200 invalid JSON and error responses never count as success or retry', async () => {
  for (const response of ['', 'not-json', 'null', '[]', '{"error":"failed"}', '{"partialSuccess":{"rejectedLogRecords":"bad"}}']) {
    await Bicho.close(0);
    setup({}, () => new Response(response));
    Bicho.captureMessage('invalid response');
    assert.equal(await Bicho.flush(), false);
    assert.equal(requests.length, 1);
  }
});

test('native local exception shape, typed tags and reserved attributes survive hooks safely', async () => {
  let local;
  setup({ serviceName: 'checkout', beforeSend(value) {
    local = structuredClone(value);
    value.tags = { ...value.tags, email: 'hidden@example.invalid', 'log.record.uid': 'wrong', 'exception.type': 'wrong', 'exception.message': 'wrong', 'exception.stacktrace': 'wrong', 'bicho.contexts': 'wrong' };
    value.contexts.private = { token: 'hidden-token', url: 'https://u:p@app.invalid/path?secret=hidden-query' };
    value.exception.stacktrace = 'Error: broken\n    at https://u:p@app.invalid/app.js?token=hidden-stack:9:3';
    return value;
  } });
  const error = new TypeError('broken');
  error.stack = 'TypeError: broken\n    at https://app.invalid/app.js:9:3';
  const id = Bicho.captureException(error, { level: 'debug', tags: { count: 3, enabled: true, region: 'eu' } });
  assert.deepEqual(local.exception, { type: 'TypeError', message: 'broken', stacktrace: error.stack });
  assert.equal(local.level, 'debug');
  assert.equal(await Bicho.flush(), true);
  assert.equal(event().event_id, id);
  assert.equal(event().exception.type, 'TypeError');
  assert.equal(event().exception.message, 'broken');
  assert.equal(event().exception.stacktrace, 'Error: broken\n    at https://app.invalid/app.js:9:3');
  assert.equal(event().contexts.private.token, '[Filtered]');
  assert.equal(event().tags.email, '[Filtered]');
  assert.equal(attributes(wire().resourceLogs[0].resource.attributes)['service.name'], 'checkout');
  const record = wire().resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(record.severityNumber, 5);
  assert.deepEqual(record.attributes.find(item => item.key === 'count').value, { doubleValue: 3 });
  assert.deepEqual(record.attributes.find(item => item.key === 'enabled').value, { boolValue: true });
  assert.equal(record.attributes.filter(item => item.key === 'log.record.uid').length, 1);
  assert.ok(!requests[0].body.includes('hidden'));
});

test('explicit lower message levels remain lower and onerror retains fallback coordinates', async () => {
  setup();
  Bicho.captureMessage('explicit info', { level: 'info' });
  const error = Object.assign(new Event('error'), { message: 'fallback', filename: 'https://u:p@app.invalid/app.js?token=hidden', lineno: 12, colno: 4 });
  globalThis.window.dispatchEvent(error);
  assert.equal(await Bicho.flush(), true);
  assert.equal(wire().resourceLogs[0].scopeLogs[0].logRecords[0].severityNumber, 9);
  assert.equal(event(1).exception.stacktrace, '    at https://app.invalid/app.js:12:4');
});

test('inline stacks cannot leak embedded source or blob identifiers', async () => {
  setup();
  const error = new Error('inline');
  error.stack = 'Error: inline\n    at data:text/javascript;base64,hidden-source:4:2\n    at blob:https://app.invalid/hidden-blob:7:3';
  Bicho.captureException(error);
  assert.equal(await Bicho.flush(), true);
  assert.ok(!requests[0].body.includes('hidden'));
  assert.ok(event().exception.stacktrace.includes('[inline]:4:2'));
  assert.ok(event().exception.stacktrace.includes('[inline]:7:3'));
});

test('queued events expire while blocked and repeated 429 retries stop after two retries', async () => {
  vi.useFakeTimers();
  setup({}, () => new Response('{}', { status: 429, headers: { 'Retry-After': '1' } }));
  Bicho.captureMessage('limited');
  const complete = Bicho.flush(10000);
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(requests.length, 1);
  await vi.advanceTimersByTimeAsync(999);
  assert.equal(requests.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(requests.length, 2);
  await vi.advanceTimersByTimeAsync(1999);
  assert.equal(requests.length, 2);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(await complete, false);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].body, requests[2].body);
  await Bicho.close(0);
  setup({}, () => new Response('{}', { status: 429, headers: { 'Retry-After': '120' } }));
  Bicho.captureMessage('one');
  Bicho.captureMessage('expires');
  const expired = Bicho.flush(61000);
  await vi.advanceTimersByTimeAsync(60000);
  assert.equal(await expired, false);
  assert.equal(requests.length, 1);
});

test('OTLP gateway failures retry twice but HTTP 500 is terminal', async () => {
  vi.useFakeTimers();
  for (const [status, attempts] of [[502, 3], [504, 3], [500, 1]]) {
    await Bicho.close(0);
    setup({}, () => new Response('{}', { status }));
    Bicho.captureMessage('gateway');
    const complete = Bicho.flush(5000);
    await vi.advanceTimersByTimeAsync(3000);
    assert.equal(await complete, false);
    assert.equal(requests.length, attempts);
    assert.equal(requests[0].body, requests.at(-1).body);
  }
});

test('invalid hook timestamps cannot create out-of-range OTLP uint64 values', async () => {
  for (const timestamp of [NaN, -1, Infinity, 253402300799]) {
    await Bicho.close(0);
    setup({ beforeSend(value) { value.timestamp = timestamp; return value; } });
    assert.equal(Bicho.captureMessage('invalid timestamp'), undefined);
    assert.equal(requests.length, 0);
  }
});
