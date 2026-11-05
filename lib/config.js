export const DEFAULTS = Object.freeze({ mode: 'screen', timeoutMs: 300000, pollIntervalMs: 2000,
  cacheTtlDays: 30, hintOnReadImage: true, hintCooldownMs: 600000 });
// Options that end up in timers/abort signals must be whole milliseconds; 1000.5 makes
// AbortSignal.timeout throw ERR_OUT_OF_RANGE after the tool has already started.
const INTEGER_OPTIONS = [['timeoutMs', 1000, 3600000], ['pollIntervalMs', 500, 30000], ['hintCooldownMs', 0, 86400000]];
export function normalizeConfig(input = {}) {
  const config = { ...DEFAULTS, ...input };
  for (const [key, min, max] of INTEGER_OPTIONS) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max)
      throw new TypeError(`Invalid ${key}: expected an integer between ${min} and ${max}.`);
  }
  const ttlDays = config.cacheTtlDays;
  if (!Number.isFinite(ttlDays) || ttlDays < 0 || ttlDays > 365)
    throw new TypeError('Invalid cacheTtlDays: expected a finite number between 0 and 365.');
  if (!['screen', 'document', 'raw'].includes(config.mode)) throw new TypeError('Invalid default OCR mode.');
  if (typeof config.hintOnReadImage !== 'boolean') throw new TypeError('hintOnReadImage must be a boolean.');
  return config;
}
