export type Level = 'fatal' | 'error' | 'warning' | 'info' | 'debug' | 'log';
export type CaptureOptions = {
  level?: Level;
  tags?: Record<string, string | number | boolean>;
  contexts?: Record<string, Record<string, unknown>>;
};
export type Event = {
  event_id: string;
  timestamp: number;
  platform: 'javascript';
  level: Level;
  message?: string;
  exception?: { type: string; message: string; stacktrace?: string };
  environment?: string;
  release?: string;
  tags?: Record<string, string | number | boolean>;
  contexts?: Record<string, unknown>;
  sdk: { name: string; version: string };
};
export type Options = CaptureOptions & {
  endpoint: string;
  key: string;
  serviceName?: string;
  environment?: string;
  release?: string;
  autoCapture?: boolean;
  beforeSend?: (event: Event) => Event | null;
};

type Pending = { payload: string; attempts: number; expires: number; ready: number };
const encoder = new TextEncoder();
const sdk = { name: 'bicho.javascript.browser', version: '1.0.0' };
const levels: Level[] = ['fatal', 'error', 'warning', 'info', 'debug', 'log'];
const sensitive = /password|passwd|secret|token|authorization|cookie|api[_-]?key|email|phone|address|^user$|^ip$/i;
let options: Options | undefined;
let endpoint = '';
let fetcher: typeof fetch;
let target: Window | undefined;
let queue: Pending[] = [];
let active: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let blockedUntil = 0;
let failed = false;
let capturing = false;
let closing = false;
let closingPromise: Promise<boolean> | undefined;
const waiters = new Set<() => void>();

function read(value: unknown, key: string): unknown {
  try { return value == null ? undefined : (value as Record<string, unknown>)[key]; }
  catch { return undefined; }
}

function text(value: unknown, limit = 2048): string {
  if (typeof value === 'string') return value.slice(0, limit);
  if (value === null || typeof value !== 'object' && typeof value !== 'function') {
    try { return String(value).slice(0, limit); } catch { return '[Unserializable]'; }
  }
  return '[Non-Error object]';
}

function scrub(value: string): string {
  return value.replace(/\b(?:data|blob):[^\s<>"')]+/gi, url => '[inline]' + (/:\d+:\d+$/.exec(url)?.[0] ?? ''))
    .replace(/\b(?:Bearer|Basic)\s+[\w+/=.-]+/gi, '[Filtered]')
    .replace(/https?:\/\/[^\s<>"')]+/gi, url => {
      const coordinates = /[?#].*?(:\d+:\d+)$/.exec(url)?.[1] ?? '';
      return url.replace(/^(https?:\/\/)[^/]*@/, '$1').split(/[?#]/)[0]! + coordinates;
    });
}

function normalize(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let budget = 300;
  function visit(input: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 5) return '[Truncated]';
    if (typeof input === 'string') return scrub(input.slice(0, 2048));
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : String(input);
    if (typeof input !== 'object') return text(input);
    if (seen.has(input)) return '[Circular]';
    seen.add(input);
    try {
      const entries = Object.keys(input).slice(0, 50).map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        return [key.slice(0, 128), sensitive.test(key) ? '[Filtered]' : descriptor && 'value' in descriptor ? visit(descriptor.value, depth + 1) : '[Accessor]'];
      });
      return Array.isArray(input) ? entries.map(entry => entry[1]) : Object.fromEntries(entries);
    } catch { return '[Unserializable]'; }
    finally { seen.delete(input); }
  }
  return visit(value, 0);
}

function tags(value: unknown): Record<string, string | number | boolean> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, string | number | boolean> = Object.create(null);
  for (const key of Object.keys(value).slice(0, 100)) {
    if (!key || key.length > 128) continue;
    const item = read(value, key);
    if (['string', 'boolean', 'number'].includes(typeof item)) result[key] = sensitive.test(key) ? '[Filtered]' : typeof item === 'string' ? scrub(item.slice(0, 512)) : typeof item === 'number' && !Number.isFinite(item) ? String(item) : item as number | boolean;
  }
  return result;
}

function validateEndpoint(endpoint: string, key: string): string {
  if (typeof endpoint !== 'string' || !/^https?:\/\/[^/?#\s\\@]+\/v1\/logs$/.test(endpoint)) throw new Error('Invalid Bicho endpoint: expected /v1/logs without credentials, query or fragment');
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Invalid Bicho endpoint'); }
  if (url.username || url.password || url.pathname !== '/v1/logs' || url.search || url.hash ||
    url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Invalid Bicho endpoint: HTTPS required except on loopback');
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw new Error('Invalid Bicho key: expected a public ingest key');
  return endpoint;
}

function attribute(key: string, value: string | number | boolean) {
  return { key, value: typeof value === 'boolean' ? { boolValue: value } : typeof value === 'number' ? { doubleValue: value } : { stringValue: value } };
}

function serialize(event: Event): string {
  const timeUnixNano = BigInt(Math.round(event.timestamp * 1000000)) * 1000n;
  if (timeUnixNano > 18446744073709551615n) throw new Error('Invalid Bicho timestamp');
  const attributes = Object.entries(event.tags ?? {}).filter(([key]) => !['exception.type', 'exception.message', 'exception.stacktrace', 'log.record.uid', 'bicho.contexts'].includes(key)).map(([key, value]) => attribute(key, value));
  attributes.push(attribute('log.record.uid', event.event_id));
  if (event.contexts) attributes.push(attribute('bicho.contexts', JSON.stringify(event.contexts)));
  if (event.exception) {
    attributes.push(attribute('exception.type', event.exception.type), attribute('exception.message', event.exception.message));
    if (event.exception.stacktrace) attributes.push(attribute('exception.stacktrace', event.exception.stacktrace));
  }
  const resources = [attribute('service.name', scrub(options!.serviceName ?? 'app/browser'))];
  if (event.release !== undefined) resources.push(attribute('service.version', event.release));
  if (event.environment !== undefined) resources.push(attribute('deployment.environment.name', event.environment));
  return JSON.stringify({ resourceLogs: [{ resource: { attributes: resources }, scopeLogs: [{ scope: sdk, logRecords: [{
    timeUnixNano: timeUnixNano.toString(),
    severityNumber: { fatal: 21, error: 17, warning: 13, info: 9, debug: 5, log: 9 }[event.level],
    severityText: event.level.toUpperCase(), body: { stringValue: event.message ?? event.exception!.message }, attributes,
  }] }] }] });
}

function notify(): void {
  if (!queue.length) for (const waiter of waiters) waiter();
}

function retryAfter(value: string | null): number {
  if (value === null) return 60000;
  const seconds = /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 60000;
}

function pump(): void {
  if (active) return;
  clearTimeout(timer);
  timer = undefined;
  while (queue.length && queue[0]!.expires <= Date.now()) {
    queue.shift();
    failed = true;
  }
  const item = queue[0];
  if (!item) { notify(); return; }
  if (Math.max(item.ready, blockedUntil) > Date.now()) {
    timer = setTimeout(pump, Math.max(0, Math.min(Math.max(item.ready, blockedUntil), item.expires) - Date.now()));
    return;
  }
  const controller = new AbortController();
  active = controller;
  const timeout = setTimeout(() => controller.abort(), Math.min(5000, Math.max(0, item.expires - Date.now())));
  void send(item, controller).finally(() => clearTimeout(timeout));
}

async function send(item: Pending, controller: AbortController): Promise<void> {
  let success = false;
  let retry = false;
  let delay = 1000 * 2 ** item.attempts;
  try {
    const response = await fetcher(endpoint, {
      method: 'POST', body: item.payload, headers: { 'Content-Type': 'application/json', 'X-Bicho-Key': options!.key },
      mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store',
      keepalive: true, signal: controller.signal,
    });
    if (active !== controller) return;
    retry = [429, 502, 503, 504].includes(response.status);
    if (response.headers.has('Retry-After')) delay = Math.max(delay, retryAfter(response.headers.get('Retry-After')));
    if (response.status === 429) {
      delay = Math.max(delay, retryAfter(response.headers.get('Retry-After')));
      blockedUntil = Math.max(blockedUntil, Date.now() + delay);
    }
    if (response.status === 200) {
      retry = false;
      try {
        const result: unknown = await response.json();
        if (result && typeof result === 'object' && !Array.isArray(result) && read(result, 'error') === undefined) {
          const partial = read(result, 'partialSuccess');
          if (partial === undefined) success = true;
          else if (partial && typeof partial === 'object' && !Array.isArray(partial)) {
            const rejected = read(partial, 'rejectedLogRecords') ?? 0;
            success = (typeof rejected === 'number' || typeof rejected === 'string') && /^(0|[1-9]\d*)$/.test(String(rejected)) && Number(rejected) === 0;
          }
        }
      } catch {}
    } else if (response.body) void response.body.cancel().catch(() => {});
  } catch { retry = true; }
  if (active !== controller) return;
  active = undefined;
  if (!success && retry && item.attempts < 2 && Date.now() + delay < item.expires) {
    item.attempts++;
    item.ready = Date.now() + delay;
  } else {
    queue.shift();
    if (!success) failed = true;
  }
  pump();
}

function capture(value: unknown, captureOptions: CaptureOptions, message: boolean, fallback?: string): string | undefined {
  if (!options || closing || capturing || queue.length >= 30 || blockedUntil > Date.now()) return undefined;
  capturing = true;
  try {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6]! & 15) | 64;
    bytes[8] = (bytes[8]! & 63) | 128;
    const id = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    const level = captureOptions.level ?? options.level ?? 'error';
    if (!levels.includes(level)) return undefined;
    let event: Event = {
      event_id: id, timestamp: Date.now() / 1000, platform: 'javascript', level,
      environment: options.environment, release: options.release,
      tags: tags({ ...options.tags, ...captureOptions.tags }),
      contexts: normalize({ ...options.contexts, ...captureOptions.contexts }) as Record<string, unknown>, sdk: { ...sdk },
    };
    if (message) event.message = scrub(text(value, 16384));
    else {
      const stack = read(value, 'stack');
      const name = read(value, 'name');
      const errorMessage = read(value, 'message');
      event.exception = {
        type: typeof name === 'string' ? scrub(name.slice(0, 512)) : 'NonError',
        message: scrub(text(typeof errorMessage === 'string' ? errorMessage : value, 16384)),
        ...(typeof stack === 'string' && stack ? { stacktrace: scrub(stack.slice(0, 32768)) } : fallback ? { stacktrace: fallback } : {}),
      };
    }
    if (options.beforeSend) {
      const changed = options.beforeSend(event);
      if (changed && typeof read(changed, 'then') === 'function') {
        void Promise.resolve(changed).catch(() => {});
        return undefined;
      }
      if (!changed || typeof changed !== 'object') return undefined;
      event = changed;
    }
    if (closing || !levels.includes(event.level)) return undefined;
    const clean: Event = {
      event_id: id, timestamp: event.timestamp, platform: 'javascript', level: event.level,
      sdk: { ...sdk }, tags: tags(event.tags),
      ...(event.contexts && typeof event.contexts === 'object' ? { contexts: normalize(event.contexts) as Record<string, unknown> } : {}),
    };
    if (!Number.isFinite(clean.timestamp) || clean.timestamp < 0 || clean.timestamp > 253402300799) return undefined;
    if (typeof event.environment === 'string') clean.environment = scrub(event.environment.slice(0, 512));
    if (typeof event.release === 'string') clean.release = scrub(event.release.slice(0, 512));
    if (typeof event.message === 'string') clean.message = scrub(event.message.slice(0, 16384));
    if (event.exception) {
      clean.exception = {
        type: scrub(text(event.exception.type, 512)), message: scrub(text(event.exception.message, 16384)),
        ...(typeof event.exception.stacktrace === 'string' ? { stacktrace: scrub(event.exception.stacktrace.slice(0, 32768)) } : {}),
      };
    }
    if (clean.message === undefined && !clean.exception) return undefined;
    const payload = serialize(clean);
    const length = encoder.encode(payload).length;
    if (length > 60 * 1024) return undefined;
    queue.push({ payload, attempts: 0, expires: Date.now() + 60000, ready: 0 });
    pump();
    return id;
  } catch { return undefined; }
  finally { capturing = false; }
}

function onError(event: ErrorEvent): void {
  try {
    if (!event.error && !event.message) return;
    const fallback = event.filename && event.lineno > 0 && event.colno > 0
      ? `    at ${scrub(event.filename).split(/[?#]/)[0]}:${event.lineno}:${event.colno}` : undefined;
    capture(event.error ?? event.message, {}, false, fallback);
  } catch {}
}

function onRejection(event: PromiseRejectionEvent): void {
  try { capture(event.reason, {}, false); } catch {}
}

export function init(configuration: Options): void {
  const url = validateEndpoint(configuration.endpoint, configuration.key);
  if (options) throw new Error('Bicho is already initialized; await close() before init()');
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function' || typeof fetch !== 'function' || typeof crypto?.getRandomValues !== 'function') {
    throw new Error('Bicho requires a browser with Fetch, Web Crypto and event listeners');
  }
  for (const key of ['environment', 'release', 'serviceName'] as const) {
    if (configuration[key] !== undefined && (typeof configuration[key] !== 'string' || configuration[key].length > 512)) throw new Error(`Invalid Bicho ${key}`);
  }
  if (configuration.beforeSend !== undefined && typeof configuration.beforeSend !== 'function') throw new Error('Invalid Bicho beforeSend');
  if (configuration.level !== undefined && !levels.includes(configuration.level)) throw new Error('Invalid Bicho level');
  options = { ...configuration };
  endpoint = url;
  fetcher = fetch.bind(globalThis);
  blockedUntil = 0;
  failed = false;
  closing = false;
  closingPromise = undefined;
  if (configuration.autoCapture !== false) {
    target = window;
    target.addEventListener('error', onError);
    target.addEventListener('unhandledrejection', onRejection);
  }
}

export function captureException(exception: unknown, captureOptions: CaptureOptions = {}): string | undefined {
  return capture(exception, captureOptions, false);
}

export function captureMessage(message: string, captureOptions: CaptureOptions = {}): string | undefined {
  return capture(message, captureOptions, true);
}

export function flush(timeoutMs = 2000): Promise<boolean> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.resolve(false);
  if (!queue.length) return Promise.resolve(!failed);
  return new Promise(resolve => {
    const done = () => { clearTimeout(timeout); waiters.delete(done); resolve(!failed); };
    const timeout = setTimeout(() => { waiters.delete(done); resolve(false); }, Math.min(timeoutMs, 2147483647));
    waiters.add(done);
  });
}

export function close(timeoutMs = 2000): Promise<boolean> {
  if (closingPromise) return closingPromise;
  if (!options) return Promise.resolve(true);
  closing = true;
  target?.removeEventListener('error', onError);
  target?.removeEventListener('unhandledrejection', onRejection);
  target = undefined;
  closingPromise = (async () => {
    const result = await flush(timeoutMs);
    clearTimeout(timer);
    const controller = active;
    active = undefined;
    controller?.abort();
    if (queue.length) failed = true;
    queue = [];
    notify();
    options = undefined;
    return result;
  })();
  return closingPromise;
}
