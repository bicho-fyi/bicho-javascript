import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { test } from 'vitest';

test('npm tarball contains usable ESM, browser exports, declarations and license', async () => {
  mkdirSync('_temp', { recursive: true });
  const temp = mkdtempSync(join('_temp', 'bicho-package-'));
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  let esm;
  let browser;
  try {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temp], { encoding: 'utf8' }));
    execFileSync('tar', ['-xzf', join(temp, packed.filename), '-C', temp]);
    const root = join(temp, 'package');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    esm = await import(pathToFileURL(join(root, manifest.exports['.'].import)).href);
    const requests = [];
    const fetch = async (url, options) => { requests.push({ url, ...options }); return new Response('{}'); };
    const sandbox = { TextEncoder, URL, crypto, AbortController, setTimeout, clearTimeout, window: new EventTarget(), fetch };
    globalThis.window = new EventTarget();
    globalThis.fetch = fetch;
    vm.runInNewContext(readFileSync(join(root, manifest.jsdelivr), 'utf8'), sandbox);
    browser = sandbox.Bicho;
    assert.equal(esm.captureMessage('side-effect free'), undefined);
    assert.equal(browser.captureMessage('uninitialized'), undefined);
    for (const name of ['init', 'captureException', 'captureMessage', 'flush', 'close']) {
      assert.equal(typeof esm[name], 'function');
      assert.equal(typeof sandbox.Bicho[name], 'function');
    }
    for (const sdk of [esm, browser]) {
      sdk.init({ endpoint: 'https://collector.invalid/v1/logs', key: 'public-key', autoCapture: false });
      const id = sdk.captureException(new Error('packed SDK'));
      assert.equal(await sdk.close(), true);
      const request = requests.at(-1);
      const scope = JSON.parse(request.body).resourceLogs[0].scopeLogs[0];
      assert.equal(scope.scope.version, manifest.version);
      assert.equal(scope.logRecords[0].attributes.find(item => item.key === 'log.record.uid').value.stringValue, id);
      assert.equal(request.headers['X-Bicho-Key'], 'public-key');
    }
    assert.equal(requests.length, 2);
    assert.match(readFileSync(join(root, manifest.types), 'utf8'), /export declare function init/);
    assert.ok(packed.files.some(file => file.path === 'ACKNOWLEDGEMENTS.md'));
    assert.equal(manifest.license, 'Apache-2.0');
    assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /Apache License\s+Version 2\.0/);
    assert.ok(!packed.files.some(file => file.path.startsWith('node_modules/')));
  } finally {
    await esm?.close(0);
    await browser?.close(0);
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
    rmSync(temp, { recursive: true, force: true });
  }
});
