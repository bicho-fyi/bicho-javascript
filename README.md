# Bicho JavaScript

[![npm version](https://img.shields.io/npm/v/@bicho-fyi/javascript)](https://www.npmjs.com/package/@bicho-fyi/javascript)
[![TypeScript ready](https://img.shields.io/badge/TypeScript-ready-3178C6?logo=typescript&logoColor=white)](https://www.npmjs.com/package/@bicho-fyi/javascript)
[![Monthly downloads](https://img.shields.io/npm/dm/@bicho-fyi/javascript)](https://www.npmjs.com/package/@bicho-fyi/javascript)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](LICENSE)

Report browser errors to your [Bicho](https://bicho.fyi) server using OpenTelemetry's OTLP/HTTP JSON protocol. Initialize once to capture uncaught JavaScript errors and unhandled promise rejections, or report caught exceptions yourself.

The SDK has no runtime dependencies. Use npm and ESM, or load the standalone script from jsDelivr. This is a browser error collector, not a full OpenTelemetry SDK or backend client.

## Install with npm

```sh
npm install @bicho-fyi/javascript
```

Initialize in your browser entry point:

```js
import * as Bicho from '@bicho-fyi/javascript';

Bicho.init({
  endpoint: 'https://collector.example/v1/logs',
  key: 'YOUR_PUBLIC_KEY',
  serviceName: 'storefront',
  environment: 'production',
  release: 'storefront@1.0.0',
  tags: { app: 'storefront' },
});
```

Use the generated `otlp.endpoint` and `otlp.headers['X-Bicho-Key']` from project provisioning. The key determines the project; a separate project ID is unnecessary. Browser projects must accept a public key without an ingest secret. Never put backend secrets or admin tokens in frontend code.

The endpoint must use HTTPS, except on loopback for local development, and point to `/v1/logs`. URL credentials, query strings and fragments are rejected. Cross-origin JSON requests with `X-Bicho-Key` require preflight; Bicho supports it.

ESM imports are safe during server rendering, but call `init()` only in the browser.

## Load from jsDelivr

```html
<script
  src="https://cdn.jsdelivr.net/npm/@bicho-fyi/javascript@1.0.0/dist/bicho.min.js"
  data-endpoint="https://collector.example/v1/logs"
  data-key="YOUR_PUBLIC_KEY"
  data-service-name="storefront"
  data-environment="production"
  data-release="storefront@1.0.0"
  defer
></script>
```

The CDN URL becomes available after version 1.0.0 is published to npm. You can host `dist/bicho.min.js` yourself, or use `dist/index.js` with native browser ESM.

| Attribute | Purpose |
| --- | --- |
| `data-endpoint`, `data-key` | Required for automatic initialization. |
| `data-service-name` | Application name (`service.name`). |
| `data-environment` | Environment (`deployment.environment.name`). |
| `data-release` | Application version (`service.version`). |
| `data-tags` | JSON labels, such as `'{"app":"storefront"}'`. |
| `data-contexts` | JSON objects, such as `'{"checkout":{"stage":"payment"}}'`. |
| `data-auto-capture` | Set to `false` for manual capture only. Defaults to `true`. |

The standalone script exposes `window.Bicho`. Without automatic initialization it waits for `Bicho.init()`. Invalid configuration throws before collection starts. Use explicit initialization for a `beforeSend` hook or to wait for consent. Use one build per page. With CSP, allow the script origin in `script-src` and the collector origin in `connect-src`.

## Capture errors yourself

```js
try {
  await submitOrder();
} catch (error) {
  Bicho.captureException(error, {
    tags: { operation: 'checkout' },
    contexts: { checkout: { stage: 'payment' } },
  });
}

Bicho.captureMessage('Catalog refresh failed');
```

Capture methods return an occurrence UID when queued, or `undefined` if dropped. A UID is not delivery confirmation. The standalone script exposes the same methods. Capturing and rethrowing an error can report two occurrences.

Exceptions and messages default to `error`. Bicho accepts exceptions at any severity, but rejects ordinary messages below ERROR. Available levels are `fatal`, `error`, `warning`, `info`, `debug` and `log`.

## Configuration

`init()` requires `endpoint` and `key`. The default service name is `app/browser`. Optional settings are `serviceName`, `environment`, `release`, `tags`, `contexts`, `level`, `autoCapture` and `beforeSend`. Set `autoCapture: false` to disable listeners.

Tags accept scalar labels. Contexts hold structured objects, serialized as bounded JSON in the `bicho.contexts` attribute. Capture options override initial tags, contexts and level. Protocol-owned attributes cannot be replaced through tags.

```js
Bicho.init({
  endpoint: 'https://collector.example/v1/logs',
  key: 'YOUR_PUBLIC_KEY',
  beforeSend(event) {
    if (event.message === 'ignore this message') return null;
    return event;
  },
});
```

Return the event or `null` from this synchronous hook. Throwing or returning a promise drops it. The SDK controls occurrence identity and its own metadata, ignores unknown top-level fields and filters the final event after the hook.

`await Bicho.flush(5000)` waits without stopping collection. It returns `true` when the queue is empty and no queued event has been permanently lost since initialization. A timeout returns `false` but leaves sending active.

`await Bicho.close(5000)` removes listeners and waits for pending events. At the deadline it aborts the active request and discards remaining events. Await `close()` before initializing again. Both methods default to two seconds; do not rely on flushing during page unload.

## Transport, privacy and limits

The SDK sends OTLP exception attributes and sanitized stack text. Each occurrence has a stable `log.record.uid`, retained across retries. Bicho derives its event lookup ID from the UID and project, so the SDK's returned UID is not the server's event ID. Equal errors can group into one issue while remaining separate occurrences.

Populated OTLP partial-success responses are never retried. Rejected records count as failed delivery. Network failures and HTTP 429/502/503/504 responses get up to two retries with the same serialized record. Rate limits, browser shutdown and request timeouts can still lose events; there is no persistent offline queue or delivery guarantee.

The SDK does not automatically collect cookies, storage, page URLs, DOM content, user identity, console output or network activity. Requests omit cookies and referrers; the collector still receives the connection IP and browser-managed headers.

Common sensitive keys are filtered in tags and contexts. Credentials, query strings and fragments are stripped from HTTP(S) URLs in captured strings. Filtering is best effort; review custom data and use `beforeSend` for application-specific filtering.

The in-memory queue holds at most 30 events. Serialized payloads over 60 KiB are dropped. Requests time out after five seconds; queued events expire after 60 seconds.

Only errors after initialization are captured. Caught exceptions, `console.error()`, failed HTTP requests and resource-loading failures without JavaScript error data are not automatic captures. Traces, sessions, page views, Web Vitals, breadcrumbs and replay are outside this SDK.

Bicho derives recognized stack locations from sanitized stack text. The SDK does not upload source maps or attach debug IDs; a release label alone does not enable source-map enrichment. Modern browsers need Fetch, AbortController, Web Crypto and TextEncoder; no polyfills are included.

## Development

Use Node 24:

```sh
npm ci
npm run check
npm test
```

`npm test` builds the SDK and runs Vitest, including packed npm tarball checks. Tests do not send errors to a live server. For manual browser checks, serve the repository locally and open `test/browser.html`.

## License

Copyright 2026 Alex Zappa (FreshJuice). Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE).
