import { init } from './index.js';
export * from './index.js';

const data = typeof document === 'undefined' ? undefined : (document.currentScript as HTMLScriptElement | null)?.dataset;
if (data && (data.endpoint !== undefined || data.key !== undefined)) {
  const object = (value: string | undefined): Record<string, never> | undefined => {
    if (value === undefined) return undefined;
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid Bicho data attribute: expected a JSON object');
    return parsed;
  };
  if (data.autoCapture !== undefined && !['true', 'false'].includes(data.autoCapture)) throw new Error('Invalid Bicho data-auto-capture: expected true or false');
  init({
    endpoint: data.endpoint!, key: data.key!, serviceName: data.serviceName, environment: data.environment, release: data.release,
    tags: object(data.tags), contexts: object(data.contexts), autoCapture: data.autoCapture !== 'false',
  });
}
