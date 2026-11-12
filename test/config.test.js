import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normalizeConfig } from '../lib/config.js';

test('timing options that feed timers and abort signals require whole milliseconds', () => {
  for (const input of [{ timeoutMs: 1000.5 }, { pollIntervalMs: 1500.5 }, { hintCooldownMs: 1.5 }])
    assert.throws(() => normalizeConfig(input), TypeError);
  assert.equal(normalizeConfig({ timeoutMs: 2000 }).timeoutMs, 2000);
  assert.equal(normalizeConfig({ pollIntervalMs: 2000 }).pollIntervalMs, 2000);
});
test('normalizeConfig validates ranges, default mode and the hint flag', () => {
  assert.throws(() => normalizeConfig({ timeoutMs: 999 }), TypeError);
  assert.throws(() => normalizeConfig({ timeoutMs: 3600001 }), TypeError);
  assert.throws(() => normalizeConfig({ cacheTtlDays: -1 }), TypeError);
  assert.throws(() => normalizeConfig({ hintOnReadImage: 'yes' }), TypeError);
  assert.throws(() => normalizeConfig({ mode: 'pdf' }), TypeError);
  assert.deepEqual(normalizeConfig({}), { ...DEFAULTS });
  assert.equal(normalizeConfig({}).mode, 'auto');
  assert.equal(normalizeConfig({ mode: 'auto' }).mode, 'auto');
  assert.equal(normalizeConfig({ mode: 'raw' }).mode, 'raw');
});
