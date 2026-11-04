#!/usr/bin/env node
/** Offline integration checks against installed, unmodified DSH packages.
 * Run: node scripts/verify-host.mjs
 * DSH_IMPLEMENTATION_ROOT may name an installed DSH root or its source checkout.
 * Only this process's resolver and network entry points are temporarily changed.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire, globalPaths, registerHooks, syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { Socket } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HOST_PACKAGES = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session-format-catalog'];
const pluginRoot = fileURLToPath(new URL('../', import.meta.url));

function inspectHostRoot(root) {
  for (const anchor of ['package.json', 'apps/cli/package.json']) {
    const filename = path.resolve(root, anchor);
    if (!existsSync(filename)) continue;
    const require = createRequire(pathToFileURL(filename));
    try {
      for (const name of HOST_PACKAGES) require.resolve(name);
      return { root: realpathSync(root), require };
    } catch { /* Try another installed/source-checkout resolution anchor. */ }
  }
}

function locateHost() {
  const override = process.env.DSH_IMPLEMENTATION_ROOT?.trim();
  if (override) {
    const host = inspectHostRoot(path.resolve(override));
    if (host) return host;
    throw new Error('DSH_IMPLEMENTATION_ROOT does not resolve all required installed host packages.');
  }
  const npmAnchors = [
    fileURLToPath(import.meta.url), process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.join(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
    path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'), 'npm/node_modules/npm/bin/npm-cli.js'),
    ...globalPaths.map(root => path.join(root, '__dsh_host_probe__.cjs')),
  ].filter(Boolean);
  for (const anchor of npmAnchors) {
    try {
      const require = createRequire(pathToFileURL(path.resolve(anchor)));
      const host = inspectHostRoot(path.dirname(require.resolve('@deepseek-ai/dsh/package.json')));
      if (host) return host;
    } catch { /* A global npm CLI may live outside this Node installation. */ }
  }
  const host = inspectHostRoot(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh'));
  if (host) return host;
  throw new Error('Installed DSH not found. Set DSH_IMPLEMENTATION_ROOT; no dependencies are installed by this script.');
}

const host = locateHost();
const resolutions = new Map();
let resolvingHost = false;
const resolver = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Node also routes createRequire().resolve() through synchronous hooks.
    if (resolvingHost || !specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context);
    resolvingHost = true;
    try {
      const filename = host.require.resolve(specifier);
      resolutions.set(specifier, filename);
      return { url: pathToFileURL(filename).href, shortCircuit: true };
    } finally { resolvingHost = false; }
  },
});

// Fail closed if a regression reaches the network: no OCR job, credentials, or files are needed.
const networkAttempts = [];
const networkTargets = [
  [globalThis, 'fetch'], [Socket.prototype, 'connect'],
  [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get'],
];
const networkOriginals = networkTargets.map(([object, key]) => [object, key, object[key]]);
for (const [object, key] of networkTargets) object[key] = function denyNetwork() {
  networkAttempts.push(key);
  throw new Error(`Host verification is offline: unexpected network entry point ${key}.`);
};
syncBuiltinESMExports();

let passed = 0;
let failed = 0;
async function check(name, run) {
  try {
    await run();
    passed++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(error?.stack || error);
  }
}

try {
  const [llm, tools, { sessionFormatCatalog: catalog }, hints, plugin, rest] = await Promise.all([
    import('@deepseek-ai/dsh-llm'), import('@deepseek-ai/dsh-tools'),
    import('@deepseek-ai/dsh-session-format-catalog'),
    import(new URL('../lib/hints.js', import.meta.url)),
    import(new URL('../lib/index.js', import.meta.url)),
    import(new URL('../lib/paddle-rest.js', import.meta.url)),
  ]);
  const { createHint, assertHintMessage, createHintHook } = hints;
  const { createUserMessage } = llm;
  const messages = [];
  const seenIds = new Set();
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const textBlock = text => ({ type: 'text', text });
  const success = Object.freeze({ content: Object.freeze([Object.freeze(textBlock('Synthetic visual result.'))]), isError: false });
  const signal = () => new AbortController().signal;

  function validateHint(message) {
    assert.equal(assertHintMessage(message), message);
    assert.match(message.id, uuidV4, 'The real factory must issue a UUID v4 identity.');
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, 'image-ocr');
    assert.ok(Array.isArray(message.content) && message.content.length > 0);
    assert.ok(message.content.every(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim()));
    for (const value of [message, message.content, message.source, ...message.content]) assert.ok(Object.isFrozen(value));
  }
  function recordHint(message) {
    validateHint(message);
    assert.ok(!seenIds.has(message.id), 'Every newly published hint must have a unique identity.');
    seenIds.add(message.id);
    messages.push(message);
    return message;
  }
  function restoreMessages(inserted) {
    const header = { version: catalog.currentVersion, id: randomUUID(), createdAt: 1700000000000,
      isSeeded: false, delegationDepth: 0, cwd: pluginRoot };
    const physicalHeader = JSON.parse(JSON.stringify(catalog.encodeCurrentHeader(header, 0)));
    const restore = catalog.createRestore(physicalHeader, { recovery: 'strict', validation: 'current' });
    const events = inserted.map((message, seq) => ({ type: 'agent/inbox/spliced', seq, time: header.createdAt + seq,
      data: { target: 'next-step', start: seq, removedCount: 0, inserted: [message] } }));
    for (const event of events) {
      const row = catalog.encodeCurrentEvent(event);
      restore.decodeRow(JSON.parse(JSON.stringify(row)));
    }
    const artifact = restore.finish();
    assert.deepEqual(artifact.header, header);
    assert.equal(artifact.inheritedEventCount, 0);
    assert.deepEqual(artifact.events, events);
    return artifact;
  }
  async function invoke(hook, options = {}) {
    const { name = 'read_image', agent = {}, result = success, decision = Object.freeze({ kind: 'accept' }),
      abortSignal = signal() } = options;
    let nextCalls = 0;
    const answer = await hook({ name, agent, arguments: { image: 'synthetic.png' }, signal: abortSignal }, result,
      async () => { nextCalls++; return decision; });
    assert.equal(nextCalls, 1, 'The downstream waterfall must run exactly once.');
    for (const message of answer?.additionalContexts || []) {
      if (!(decision?.additionalContexts || []).includes(message)) recordHint(message);
    }
    return { answer, decision };
  }
  function capturePlugin(config = {}, capabilities = {}) {
    const definitions = [];
    const listeners = [];
    const unexpectedFs = async () => { throw new Error('Unexpected host filesystem access.'); };
    const ctx = {
      tools: { register(tool) { definitions.push(tool); return () => {}; } },
      on(event, listener) { listeners.push({ event, listener }); return () => {}; },
      fs: { resolve: unexpectedFs, stat: unexpectedFs, readBytes: unexpectedFs, ...capabilities.fs },
      workingDirectory: { ensure: unexpectedFs, ...capabilities.workingDirectory },
    };
    plugin.apply(ctx, config);
    assert.equal(definitions.length, 1);
    assert.equal(listeners.length, 1);
    assert.equal(listeners[0].event, 'tools/post-execute');
    return { tool: definitions[0], hook: listeners[0].listener };
  }

  await check('real host package imports and current V4 catalog', () => {
    for (const name of HOST_PACKAGES) {
      assert.equal(realpathSync(resolutions.get(name)), realpathSync(host.require.resolve(name)));
      const metadata = JSON.parse(readFileSync(host.require.resolve(`${name}/package.json`), 'utf8'));
      assert.equal(metadata.name, name);
      console.log(`  ${name}@${metadata.version}`);
    }
    assert.equal(typeof tools.defineTool, 'function');
    assert.equal(typeof createUserMessage, 'function');
    assert.equal(catalog.currentVersion, 4);
    console.log(`  host: ${host.root}`);
  });

  await check('host message factory detaches and deep-freezes its input', () => {
    const input = { source: { kind: 'image-ocr' }, content: [textBlock('Synthetic factory input.')] };
    const message = createUserMessage(input);
    validateHint(message);
    input.source.kind = 'changed';
    input.content[0].text = 'changed';
    assert.equal(message.source.kind, 'image-ocr');
    assert.equal(message.content[0].text, 'Synthetic factory input.');
  });

  await check('hint factory emits complete immutable messages with unique UUIDs', () => {
    for (let index = 0; index < 64; index++) recordHint(createHint());
    const message = messages[0];
    assert.throws(() => { message.id = 'changed'; }, TypeError);
    assert.throws(() => { message.role = 'assistant'; }, TypeError);
    assert.throws(() => { message.source.kind = 'plugin'; }, TypeError);
    assert.throws(() => { message.content[0].text = 'changed'; }, TypeError);
    assert.throws(() => message.content.push(textBlock('changed')), TypeError);
  });

  await check('hint assertion rejects legacy strings, plugin sources, and partial messages', () => {
    const good = messages[0];
    const { id: _id, ...noId } = good;
    const bad = [undefined, null, 'legacy OCR hint', {}, noId, { ...good, id: '' },
      { ...good, role: 'assistant' }, { ...good, source: { kind: 'plugin', plugin: 'image-ocr' } },
      { ...good, source: undefined }, { ...good, content: 'legacy text' }, { ...good, content: [] },
      { ...good, content: [{ type: 'image', text: 'wrong block' }] },
      { ...good, content: [{ type: 'text', text: 1 }] }];
    for (const value of bad) assert.throws(() => assertHintMessage(value), TypeError);
  });

  await check('kind:accept adds one complete hint for each supported image reader', async () => {
    const hook = createHintHook();
    for (const name of ['read_image', 'acp_read_original_image']) {
      const { answer, decision } = await invoke(hook, { name });
      assert.equal(answer.kind, 'accept');
      assert.equal(answer.additionalContexts.length, 1);
      assert.ok(!Object.hasOwn(answer, 'action'));
      assert.ok(!Object.hasOwn(decision, 'additionalContexts'));
    }
  });

  await check('kind:block is unchanged and does not start cooldown', async () => {
    const hook = createHintHook();
    const agent = {};
    const blocked = Object.freeze({ kind: 'block', feedback: Object.freeze([Object.freeze(textBlock('Blocked by policy.'))]) });
    assert.equal((await invoke(hook, { agent, decision: blocked })).answer, blocked);
    assert.equal((await invoke(hook, { agent })).answer.additionalContexts.length, 1);
  });

  await check('only the current kind discriminator permits injection', async () => {
    const hook = createHintHook({ cooldownMs: 0 });
    for (const decision of [{ action: 'accept' }, { action: 'block' }, { kind: 'block', action: 'accept', feedback: [] }, {}, null]) {
      assert.equal((await invoke(hook, { decision })).answer, decision);
    }
    const { answer } = await invoke(hook, { decision: { kind: 'accept', action: 'block' } });
    assert.equal(answer.additionalContexts.length, 1, 'A retired action field must not override the current kind.');
  });

  await check('error results do not add hints or consume cooldown', async () => {
    for (const result of [{ ...success, isError: true }, { ...success, ok: false }]) {
      const hook = createHintHook();
      const agent = {};
      const { answer, decision } = await invoke(hook, { agent, result });
      assert.equal(answer, decision);
      assert.equal((await invoke(hook, { agent })).answer.additionalContexts.length, 1);
    }
  });

  await check('downstream errors propagate without consuming cooldown', async () => {
    const hook = createHintHook();
    const agent = {};
    const failure = new Error('Synthetic downstream failure.');
    let calls = 0;
    await assert.rejects(hook({ name: 'read_image', agent, signal: signal() }, success,
      async () => { calls++; throw failure; }), error => error === failure);
    assert.equal(calls, 1);
    assert.equal((await invoke(hook, { agent })).answer.additionalContexts.length, 1);
  });

  await check('cooldown uses the boundary correctly, including clock zero and independent agents', async () => {
    let time = 0;
    const hook = createHintHook({ cooldownMs: 1000, now: () => time });
    const agent = {};
    assert.equal((await invoke(hook, { agent })).answer.additionalContexts.length, 1);
    time = 999;
    const suppressed = await invoke(hook, { agent, name: 'acp_read_original_image' });
    assert.equal(suppressed.answer, suppressed.decision);
    assert.equal((await invoke(hook, { agent: {} })).answer.additionalContexts.length, 1);
    time = 1000;
    assert.equal((await invoke(hook, { agent, name: 'acp_read_original_image' })).answer.additionalContexts.length, 1);
  });

  await check('existing contexts and accepted content are preserved without mutation', async () => {
    const previous = createUserMessage({ content: [textBlock('Pre-existing context.')], source: { kind: 'user' } });
    const contexts = Object.freeze([previous]);
    const content = Object.freeze([Object.freeze(textBlock('Replacement result.'))]);
    const decision = Object.freeze({ kind: 'accept', content, additionalContexts: contexts });
    const { answer } = await invoke(createHintHook(), { decision });
    assert.notEqual(answer, decision);
    assert.equal(answer.content, content);
    assert.equal(answer.additionalContexts.length, 2);
    assert.equal(answer.additionalContexts[0], previous);
    assert.deepEqual(decision.additionalContexts, [previous]);
    restoreMessages(answer.additionalContexts);
  });

  await check('a new successful OCR result starts and renews reader-hint cooldown', async () => {
    let time = 0;
    const hook = createHintHook({ cooldownMs: 1000, now: () => time });
    const agent = {};
    const ocr = await invoke(hook, { agent, name: 'read_image_text' });
    assert.equal(ocr.answer, ocr.decision);
    const immediate = await invoke(hook, { agent });
    assert.equal(immediate.answer, immediate.decision);
    time = 1000;
    assert.equal((await invoke(hook, { agent })).answer.additionalContexts.length, 1);
    time = 1500;
    const renewed = await invoke(hook, { agent, name: 'read_image_text' });
    assert.equal(renewed.answer, renewed.decision);
    time = 2000;
    const suppressed = await invoke(hook, { agent });
    assert.equal(suppressed.answer, suppressed.decision);
    time = 2500;
    assert.equal((await invoke(hook, { agent })).answer.additionalContexts.length, 1);
  });

  await check('failed or blocked OCR does not suppress the next reader hint', async () => {
    for (const options of [{ result: { ...success, isError: true } }, { result: { ...success, ok: false } },
      { decision: { kind: 'block', feedback: [textBlock('OCR blocked.')] } }]) {
      const hook = createHintHook();
      const agent = {};
      const ocr = await invoke(hook, { ...options, agent, name: 'read_image_text' });
      assert.equal(ocr.answer, ocr.decision);
      assert.equal((await invoke(hook, { agent })).answer.additionalContexts.length, 1);
    }
  });

  await check('aborted or agentless executions leave the downstream decision unchanged', async () => {
    const hook = createHintHook();
    for (const agent of [null, 'agent-id', 7]) {
      const outcome = await invoke(hook, { agent });
      assert.equal(outcome.answer, outcome.decision);
    }
    const decision = { kind: 'accept' };
    assert.equal(await hook({ name: 'read_image', signal: signal() }, success, async () => decision), decision);
    const agent = {};
    const controller = new AbortController();
    controller.abort(new Error('Synthetic cancellation.'));
    const aborted = await invoke(hook, { agent, abortSignal: controller.signal });
    assert.equal(aborted.answer, aborted.decision);
    assert.equal((await invoke(hook, { agent })).answer.additionalContexts.length, 1);
  });

  await check('disabled/unrelated hooks are inert and zero cooldown allows fresh hints', async () => {
    for (const [hook, name] of [[createHintHook({ enabled: false }), 'read_image'], [createHintHook(), 'unrelated_tool']]) {
      const outcome = await invoke(hook, { name });
      assert.equal(outcome.answer, outcome.decision);
    }
    const agent = {};
    const hook = createHintHook({ cooldownMs: 0 });
    for (let index = 0; index < 2; index++) assert.equal((await invoke(hook, { agent })).answer.additionalContexts.length, 1);
    assert.equal((await invoke(createHintHook(), { agent })).answer.additionalContexts.length, 1);
  });

  await check('apply registers a real defineTool with parameter and output schemas', () => {
    const { tool } = capturePlugin();
    assert.equal(tool.name, 'read_image_text');
    assert.equal(tool.parameters.type, 'object');
    assert.deepEqual(tool.parameters.required, ['image']);
    assert.equal(tool.parameters.properties.image.type, 'string');
    assert.deepEqual(tool.parameters.properties.mode.enum, ['screen', 'document', 'raw']);
    assert.equal(tool.parameters.properties.pageRanges.type, 'string');
    assert.equal(tool.parameters.properties.refresh.type, 'boolean');
    assert.equal(tool.output.schema.type, 'string');
    assert.equal(tool.timeoutMs, 300000);
    assert.notEqual(tool.isConcurrencySafe?.({ image: 'synthetic.png' }), true);
    const value = 'Synthetic OCR result, with no upload.';
    assert.deepEqual(tools.validateJsonSchemaValue(tool.output.schema, value, ''), []);
    assert.deepEqual(tool.output.render({ image: 'synthetic.png' }, value), [textBlock(value)]);
  });

  await check('actual defineTool argument validation rejects invalid calls before any file access', async () => {
    const { tool } = capturePlugin();
    for (const args of [{}, { image: 1 }, { image: 'synthetic.png', mode: 'invalid' },
      { image: 'synthetic.png', pageRanges: 1 }, { image: 'synthetic.png', refresh: 'yes' }]) {
      await assert.rejects(tool.execute(args, { agent: {}, signal: signal() }), tools.ToolArgsError);
    }
    await assert.rejects(tool.execute({ image: '   ' }, { agent: {}, signal: signal() }), /non-empty/);
    const failure = new Error('Synthetic cancellation before filesystem access.');
    await assert.rejects(tool.execute({ image: 'synthetic.png' }, { agent: {}, signal: AbortSignal.abort(failure) }), error => error === failure);
  });

  await check('host filesystem failures propagate without a native-read or network bypass', async () => {
    const calls = [];
    const agent = {};
    const abortSignal = signal();
    const failure = new Error('Synthetic host backend read denied.');
    const { tool } = capturePlugin({}, {
      workingDirectory: { async ensure(value, receivedSignal) {
        assert.equal(value, agent); assert.equal(receivedSignal, abortSignal); calls.push('cwd'); return pluginRoot;
      } },
      fs: {
        async resolve(image, options) {
          assert.equal(image, 'synthetic.png'); assert.equal(options.cwd, pluginRoot);
          assert.equal(options.signal, abortSignal); calls.push('resolve'); return 'synthetic-resolved-target';
        },
        async stat(target, receivedSignal) {
          assert.equal(target, 'synthetic-resolved-target'); assert.equal(receivedSignal, abortSignal);
          calls.push('stat'); return { type: 'file', size: 16 };
        },
        async readBytes(target, receivedSignal, maxBytes) {
          assert.equal(target, 'synthetic-resolved-target'); assert.equal(receivedSignal, abortSignal);
          assert.equal(maxBytes, rest.MAX_UPLOAD_BYTES); calls.push('readBytes'); throw failure;
        },
      },
    });
    await assert.rejects(tool.execute({ image: 'synthetic.png' }, { agent, signal: abortSignal }), error => error === failure);
    assert.deepEqual(calls, ['cwd', 'resolve', 'stat', 'readBytes']);
  });

  await check('non-files and oversized inputs are rejected before reading bytes', async () => {
    for (const [info, expected] of [[{ type: 'directory', size: 0 }, /regular file/],
      [{ type: 'file', size: rest.MAX_UPLOAD_BYTES + 1 }, /25 MiB/]]) {
      const { tool } = capturePlugin({}, { fs: { async resolve() { return 'synthetic-resolved-target'; }, async stat() { return info; } } });
      await assert.rejects(tool.execute({ image: 'synthetic.png' }, { signal: signal() }), expected);
    }
  });

  await check('registered post-execute hook respects config and emits real host messages', async () => {
    const enabled = capturePlugin({ hintCooldownMs: 0, timeoutMs: 2500 });
    assert.equal(enabled.tool.timeoutMs, 2500);
    const agent = {};
    for (let index = 0; index < 2; index++) assert.equal((await invoke(enabled.hook, { agent })).answer.additionalContexts.length, 1);
    const disabled = capturePlugin({ hintOnReadImage: false });
    const outcome = await invoke(disabled.hook, { agent });
    assert.equal(outcome.answer, outcome.decision);
  });

  await check('every emitted hint survives strict/current encode, decodeRow, and finish', () => {
    assert.ok(messages.length >= 64);
    for (const message of messages) validateHint(message);
    const restored = restoreMessages(messages);
    assert.equal(restored.events.length, messages.length);
    for (let index = 0; index < messages.length; index++) {
      assert.equal(restored.events[index].data.target, 'next-step');
      assert.deepEqual(restored.events[index].data.inserted[0], messages[index]);
    }
    console.log(`  ${messages.length} unique hint messages restored through agent/inbox/spliced.`);
  });

  await check('strict/current catalog refuses legacy string and kind:plugin inbox entries', () => {
    assert.throws(() => restoreMessages(['Legacy bare-string OCR context.']), { name: 'SessionFormatError' });
    assert.throws(() => restoreMessages([{ ...messages[0], source: { kind: 'plugin', plugin: 'image-ocr' } }]),
      { name: 'SessionFormatError' });
  });

  await check('verification made no network attempts', () => assert.deepEqual(networkAttempts, []));
} catch (error) {
  failed++;
  console.error(error?.stack || error);
} finally {
  resolver.deregister();
  for (const [object, key, original] of networkOriginals) object[key] = original;
  syncBuiltinESMExports();
}

console.log(`Host integration: ${passed} passed, ${failed} failed; offline synthetic data only.`);
if (failed) process.exitCode = 1;
