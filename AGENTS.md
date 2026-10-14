# Bicho JavaScript SDK

## Project

`@bicho-fyi/javascript` is a dependency-free browser error collector using OTLP/HTTP JSON. Read README.md and relevant source/tests before editing. Use npm and Node 24.

- `src/index.ts`: side-effect-free ESM API; safe to import during server rendering.
- `src/browser.ts`: standalone script initialization from data attributes.
- `scripts/build.mjs`: CDN bundle build. Edit source, not generated `dist/` files.
- `test/`: Vitest browser, transport and npm package checks.

## Guardrails

- For agent-assisted work, commit or push only when the user says "yolo" for that task. Publishing and history rewrites require separate explicit approval.
- Check branch, remotes and changes before staging; preserve unrelated work. Keep scratch files in ignored `_temp/`. Never expose or commit credentials.
- Use local tests by default. Live collector writes, deployment and browser automation require explicit permission. Do not assume a sibling server checkout exists.
- Keep changes focused. Reuse existing helpers and native browser APIs; avoid speculative abstractions and runtime dependencies. Add comments only when needed to explain a non-obvious constraint.

## SDK invariants

- Initialize with `endpoint` and a public ingest `key`; never put backend secrets in browser code. Keep ESM initialization separate from script-tag auto-initialization.
- Send valid OTLP JSON. Preserve occurrence UID and serialized payload across retries; tags and hooks cannot override protocol-owned attributes. Never retry populated partial-success responses.
- Messages default to ERROR. Keep queues, payloads, retries and timeouts bounded; preserve listener cleanup, cancellation and `flush()`/`close()` behavior.
- Filter the final event after `beforeSend`. Do not add automatic identity, cookie, storage, DOM, console or network collection. Collector failures must not trigger recursive capture.

## Verification and documentation

Run `npm run check` and `npm test` after behavior changes. The test command builds ESM, declarations and the CDN bundle, then checks the packed npm package. Documentation-only edits need `git diff --check`. Report what passed and what was not tested.

Write plain English with sentence-case headings. Document actual behavior and limitations: queued does not mean delivered, and local tests do not prove live deployment. Keep README examples, public types and script attributes aligned. Update package.json, package-lock.json, emitted SDK version and pinned CDN examples together when changing versions.

Keep the Apache-2.0 license text and copyright attribution intact. Preserve applicable upstream licenses and notices; do not add redundant attribution files.
