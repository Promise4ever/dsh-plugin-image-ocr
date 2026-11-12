/**
 * Regression tests for the browser-half state machine.
 *
 * `client.js` is a browser bundle, so it is evaluated in a `node:vm` context with
 * the smallest possible `window`/React/plugin-context stubs. The tests drive the
 * real shipped draft/save code through the bundle's internal `__test` seam; no
 * DOM, network, credential store or profile is touched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '..', 'client.js'), 'utf8');
const ENTRY_ID = 'dsh-plugin-image-ocr';

function loadBundle() {
  const captured = {};
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value, () => {}],
    useEffect: () => {},
    useSyncExternalStore: () => ({}),
  };
  const sandbox = {
    window: {
      React,
      __ModuleLoader__: { load: definition => { captured.bundle = definition; } },
    },
    require: () => React,
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  assert.equal(captured.bundle?.id, ENTRY_ID);
  return captured.bundle.factory(sandbox.require);
}

function createHarness() {
  const values = {};
  const ops = [];
  let gate = null;
  const form = {
    getSnapshot: () => ({ status: 'ready', value: { ...values }, revision: 1, writable: true }),
    subscribe: () => () => {},
    mutate: async batch => {
      ops.push(...batch);
      if (gate !== null) await gate;
      for (const op of batch) if (op.op === 'set') values[op.path[0]] = op.value;
      return true;
    },
  };
  const credentials = {
    describe: async () => ({ ok: true, value: {} }),
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true }),
  };
  const ctx = {
    slots: { inject: () => () => {}, register: () => () => {} },
    remote: { credentials, $on: () => () => {} },
    configForms: { get: ns => (ns === ENTRY_ID ? form : undefined) },
    effect: () => () => {},
  };
  const plugin = loadBundle();
  plugin.apply(ctx);
  return {
    plugin,
    api: plugin.__test,
    values,
    ops,
    setValue: (key, value) => { values[key] = value; },
    hold: () => {
      let release;
      gate = new Promise(resolve => { release = () => { gate = null; resolve(); }; });
      return release;
    },
  };
}

test('client defaults include the automatic scene', () => {
  const { api } = createHarness();
  const snapshot = api.snapshot();
  assert.equal(snapshot.saved.mode, 'auto');
  assert.equal(snapshot.draft.mode, 'auto');
  assert.equal(snapshot.dirty, false);
});

test('a save keeps edits made during the write dirty and reports them', async () => {
  const h = createHarness();
  h.api.patchDraft('cacheTtlDays', 31);
  const release = h.hold();
  const saving = h.api.saveAll();
  await Promise.resolve();
  h.api.patchDraft('cacheTtlDays', 32);
  release();
  await saving;
  const snapshot = h.api.snapshot();
  assert.equal(snapshot.saving, false);
  assert.equal(snapshot.saved.cacheTtlDays, 31);
  assert.equal(snapshot.draft.cacheTtlDays, 32);
  assert.equal(snapshot.dirty, true);
  assert.match(snapshot.saveMessage, /保存期间的新改动尚未写入/);
});

test('external updates rebase untouched fields and are not rolled back by the next save', async () => {
  const h = createHarness();
  h.api.patchDraft('model', 'PP-OCRv6');
  h.setValue('cacheTtlDays', 31);
  h.api.syncFromForm();
  let snapshot = h.api.snapshot();
  assert.equal(snapshot.saved.cacheTtlDays, 31);
  assert.equal(snapshot.draft.cacheTtlDays, 31);
  assert.equal(snapshot.draft.model, 'PP-OCRv6');
  assert.equal(snapshot.dirty, true);
  await h.api.saveAll();
  assert.deepEqual(h.ops.map(op => op.path[0]), ['model']);
  snapshot = h.api.snapshot();
  assert.equal(snapshot.dirty, false);
  assert.equal(h.values.cacheTtlDays, 31);
});

test('restoring defaults when already at defaults is clean and writes nothing', async () => {
  const h = createHarness();
  h.api.resetDraft();
  assert.equal(h.api.snapshot().dirty, false);
  await h.api.saveAll();
  assert.equal(h.ops.length, 0);
  assert.equal(h.api.snapshot().dirty, false);
  assert.equal(h.api.snapshot().saveMessage, '当前没有需要保存的改动。');
});

test('restoring defaults differs from a non-default saved snapshot and saves cleanly', async () => {
  const h = createHarness();
  h.setValue('model', 'PP-OCRv6');
  h.api.syncFromForm();
  h.api.resetDraft();
  assert.equal(h.api.snapshot().dirty, true);
  await h.api.saveAll();
  assert.equal(h.api.snapshot().dirty, false);
  assert.deepEqual(h.ops.map(op => op.path[0]), ['model']);
  assert.equal(h.values.model, 'PaddleOCR-VL-1.6');
});
