# Changelog

This package follows [Semantic Versioning](https://semver.org/): patch releases fix bugs, minor releases add compatible features, and major releases contain breaking changes.

## [1.1.0] (2026-10-14)

### Added

- Manual error reporting in Node.js 24+ without browser globals.
- `createClient()` for isolated configuration, context, queues and shutdown per request.
- Backend examples and tests for concurrent clients, HTTP delivery and packed exports.

### Changed

- The default service name is `app/backend` outside the browser. Browser clients keep `app/browser` and automatic error listeners.
- Backend requests use manual redirect handling so the ingest key is never forwarded to a redirect target.

## [1.0.0]

### Added

- Browser error and unhandled promise rejection capture, with manual exception and message reporting.
- OTLP/HTTP JSON transport with public-key authentication, stable occurrence IDs, bounded retries and delivery timeouts.
- Context filtering, a `beforeSend` hook, and `flush()` and `close()` controls.
- ESM exports, TypeScript declarations and a standalone browser bundle.
