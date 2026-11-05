import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, resolveToken, normalizePageRanges, mediaType, buildMultipart, cacheKey,
  parseResults, validateResultUrl, normalizeTransportError, OcrError, MODEL } from '../lib/paddle-rest.js';
const PNG = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const TOKEN = 'synthetic-test-credential';
const row = text => JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text, images: { unused: 'https://never.invalid/image.png' } } }] } });
const resultUrl = 'https://ocr-test.bcebos.com/result.jsonl?signature=synthetic';
async function fixture(t, options = {}) {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ocr-test-'));
  t.after(() => fs.rm(cacheDir, { recursive: true, force: true }));
  const calls = [], sleeps = [];
  let clock = 1000000;
  const send = async (url, req) => {
    calls.push({ url, ...req });
    if (options.send) return options.send(url, req, calls);
    if (req.method === 'POST') return { status: 200, text: JSON.stringify({ code: 0, data: { jobId: 'test-job' } }) };
    if (url === resultUrl) return { status: 200, text: row('识别结果 $x^2$') };
    return { status: 200, text: JSON.stringify({ code: 0, data: { state: 'done', resultUrl: { jsonUrl: resultUrl } } }) };
  };
  const config = { token: TOKEN, cacheDir, timeoutMs: 10000, ...options.config };
  const client = createClient(config, { request: send, now: () => clock,
    sleep: async (ms, signal) => { signal.throwIfAborted(); sleeps.push(ms); clock += ms; options.onSleep?.(ms, signal); },
    resolveToken: options.resolveToken || (async () => TOKEN) });
  return { client, calls, sleeps, config, advance: ms => { clock += ms; } };
}
test('credential priority: config → nonempty env → independent token file', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ocr-token-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.writeFile(path.join(home, 'ocr-token.txt'), 'synthetic-file-credential\n');
  const env = { DSH_HOME: home, AISTUDIO_ACCESS_TOKEN: 'synthetic-env-credential' };
  assert.equal(await resolveToken({ token: ' config-value ' }, env), 'config-value');
  assert.equal(await resolveToken({ token: '  ' }, env), 'synthetic-env-credential');
  assert.equal(await resolveToken({}, { DSH_HOME: home }), 'synthetic-file-credential');
  await fs.rm(path.join(home, 'ocr-token.txt'));
  await assert.rejects(resolveToken({}, { DSH_HOME: home }), { code: 'NO_TOKEN' });
});
test('token file rejects multiple lines and oversized files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ocr-token-invalid-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'ocr-token.txt');
  await fs.writeFile(file, 'line1\nline2');
  await assert.rejects(resolveToken({}, { DSH_HOME: root }), { code: 'NO_TOKEN' });
  await fs.writeFile(file, 'a'.repeat(8193));
  await assert.rejects(resolveToken({}, { DSH_HOME: root }), { code: 'TOKEN_FILE_INVALID' });
});
test('normalizes one-based page ranges, rejects reversed/zero/injected ranges', () => {
  assert.equal(normalizePageRanges(' 1-3, 5 '), '1-3,5');
  for (const value of ['0', '3-1', '1,', '-2', 'NaN', '1\r\nX:Y', '9'.repeat(32)])
    assert.throws(() => normalizePageRanges(value), { code: 'INVALID_PAGE_RANGES' });
});
test('MIME sniff blocks arbitrary text disguised as an image', () => {
  assert.equal(mediaType(PNG)[0], 'image/png');
  assert.equal(mediaType(Buffer.from('%PDF-1.7'))[0], 'application/pdf');
  assert.throws(() => mediaType(Buffer.from('private text')), { code: 'UNSUPPORTED_FILE' });
});
test('multipart uses fixed model, camelCase params, selected pages, anonymous filename', () => {
  const { body, contentType } = buildMultipart(PNG, { mode: 'document', pageRanges: '2-3' });
  const text = body.toString();
  assert.match(contentType, /^multipart\/form-data; boundary=/);
  assert.match(text, /PaddleOCR-VL-1.6/);
  assert.match(text, /"useLayoutDetection":true/);
  assert.match(text, /name="pageRanges"\r\n\r\n2-3/);
  assert.match(text, /filename="input.png"/);
});
test('cache key isolates file, mode, pages, account', () => {
  const a = { mode: 'screen', pageRanges: '', token: TOKEN };
  const key = cacheKey(PNG, a);
  assert.match(key, /^[0-9a-f]{64}$/);
  for (const opts of [{ ...a, mode: 'document' }, { ...a, pageRanges: '2' }, { ...a, token: 'other-account' }])
    assert.notEqual(cacheKey(PNG, opts), key);
  assert.notEqual(cacheKey(Buffer.concat([PNG, Buffer.from('extra')]), a), key);
});
test('parse JSONL pages; images remain unfetched and invalid/empty results fail', () => {
  assert.deepEqual(parseResults(`\uFEFF${row('one')}\r\n${row('two')}\n`), { pages: 2, text: 'one\n\n---\n\ntwo' });
  assert.throws(() => parseResults('not json'), { code: 'INVALID_RESULT' });
  assert.throws(() => parseResults('{}'), { code: 'INVALID_RESULT' });
  assert.throws(() => parseResults(row('')), { code: 'EMPTY_RESULT' });
});
test('result URLs are restricted to HTTPS service/storage domains', () => {
  assert.equal(validateResultUrl(resultUrl), resultUrl);
  for (const url of ['http://ocr.bcebos.com/a', 'https://127.0.0.1/a', 'https://bcebos.com.evil.invalid/a',
    'https://user:pass@a.bcebos.com/a', 'file:///etc/passwd', 'https://a.bcebos.com:1234/a', undefined])
    assert.throws(() => validateResultUrl(url));
});
test('REST success downloads JSONL only and never forwards authorization to storage', async t => {
  const { client, calls } = await fixture(t);
  const result = await client.run(PNG, { mode: 'document', pageRanges: '1' });
  assert.equal(result.model, MODEL); assert.equal(result.pages, 1); assert.equal(result.cached, false);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers.Authorization, `bearer ${TOKEN}`);
  assert.equal(calls[2].url, resultUrl);
  assert.equal(calls[2].headers, undefined);
});
test('repeat invocation uses local cache with no network; refresh submits again', async t => {
  const { client, calls } = await fixture(t);
  await client.run(PNG);
  assert.equal((await client.run(PNG)).cached, true);
  assert.equal(calls.length, 3);
  assert.equal((await client.run(PNG, { refresh: true })).cached, false);
  assert.equal(calls.length, 6);
});
test('expired and corrupted caches are ignored', async t => {
  const { client, calls, config, advance } = await fixture(t);
  await client.run(PNG); advance(31 * 86400000);
  await client.run(PNG); assert.equal(calls.length, 6);
  const files = await fs.readdir(config.cacheDir);
  for (const file of files) await fs.writeFile(path.join(config.cacheDir, file), '{broken');
  await client.run(PNG); assert.equal(calls.length, 9);
});
test('429 and API rate limit code retry with bounded delay', async t => {
  let posts = 0;
  const f = await fixture(t, { send: async (url, req) => {
    if (req.method === 'POST') {
      posts++;
      if (posts < 3) return { status: posts === 1 ? 429 : 200, headers: { 'retry-after': '1' }, text: '{"code":12002}' };
      return { status: 200, text: '{"code":0,"data":{"jobId":"rate-job"}}' };
    }
    if (url === resultUrl) return { status: 200, text: row('retry succeeded') };
    return { status: 200, text: JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: resultUrl } } }) };
  } });
  assert.equal((await f.client.run(PNG)).pages, 1); assert.equal(posts, 3);
  assert.deepEqual(f.sleeps.filter(ms => ms > 0), [1000,1000]);
});
test('permanent 429 fails without an infinite retry loop', async t => {
  const { client, calls } = await fixture(t, { send: async () => ({ status: 429, text: '{"code":12002}' }) });
  await assert.rejects(client.run(PNG), { code: 'RATE_LIMITED' }); assert.equal(calls.length, 5);
});
test('ambiguous POST network errors do not create duplicate jobs', async t => {
  const { client, calls } = await fixture(t, { send: async () => { const e = new Error('synthetic network failure'); e.code = 'NETWORK_ERROR'; throw e; } });
  await assert.rejects(client.run(PNG), { code: 'NETWORK_ERROR' }); assert.equal(calls.length, 1);
});
test('pending/running poll until done and do not fetch result images', async t => {
  let polls = 0;
  const f = await fixture(t, { send: async (url, req) => {
    if (req.method === 'POST') return { status: 200, text: '{"data":{"jobId":"poll-job"}}' };
    if (url === resultUrl) return { status: 200, text: row('done') };
    polls++;
    return { status: 200, text: JSON.stringify({ data: { state: ['pending','running','done'][polls - 1], resultUrl: { jsonUrl: resultUrl } } }) };
  } });
  await f.client.run(PNG); assert.equal(polls, 3); assert.equal(f.sleeps.filter(ms => ms === 2000).length, 2);
});
test('authentication errors do not expose credentials or response body', async t => {
  const { client } = await fixture(t, { send: async () => ({ status: 401, text: JSON.stringify({ code: 999, msg: TOKEN }) }) });
  await assert.rejects(client.run(PNG), error => error.code === 'AUTH_FAILED' && !error.message.includes(TOKEN));
});
test('failed jobs clear checkpoints, invalid states and bad result downloads fail', async t => {
  for (const [state, code] of [['failed', 'JOB_FAILED'], ['mystery', 'INVALID_JOB_STATE']]) {
    const f = await fixture(t, { send: async (_url, req) => ({ status: 200,
      text: JSON.stringify({ data: req.method === 'POST' ? { jobId: 'failed-job' } : { state } }) }) });
    await assert.rejects(f.client.run(PNG), { code });
    if (state === 'failed') assert.deepEqual(await fs.readdir(f.config.cacheDir), []);
  }
  const f = await fixture(t, { send: async (url, req) => {
    if (req.method === 'POST') return { status: 200, text: '{"data":{"jobId":"bad-download"}}' };
    if (url === resultUrl) return { status: 404, text: 'missing' };
    return { status: 200, text: JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: resultUrl } } }) };
  } });
  await assert.rejects(f.client.run(PNG), { code: 'RESULT_FETCH_FAILED' });
});
test('pre-aborted calls perform no I/O', async t => {
  const { client, calls } = await fixture(t);
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  await assert.rejects(client.run(PNG, { signal: controller.signal }), /cancelled/);
  assert.equal(calls.length, 0);
});
test('cancellation saves a job checkpoint; retry resumes instead of re-submitting', async t => {
  const controller = new AbortController(); let first = true;
  const f = await fixture(t, { onSleep: ms => { if (ms === 2000 && first) { first = false; controller.abort(new Error('cancelled')); } },
    send: async (url, req) => {
      req.signal.throwIfAborted();
      if (req.method === 'POST') return { status: 200, text: '{"data":{"jobId":"resume-job"}}' };
      if (url === resultUrl) return { status: 200, text: row('resumed') };
      return { status: 200, text: JSON.stringify({ data: { state: first ? 'running' : 'done', resultUrl: { jsonUrl: resultUrl } } }) };
    } });
  await assert.rejects(f.client.run(PNG, { signal: controller.signal }), /cancelled/);
  assert.equal((await fs.readdir(f.config.cacheDir)).filter(name => name.endsWith('.job.json')).length, 1);
  assert.equal((await f.client.run(PNG)).text, 'resumed');
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});
test('invalid modes, unsupported content and oversized input never submit', async t => {
  const { client, calls } = await fixture(t);
  await assert.rejects(client.run(PNG, { mode: 'unknown' }), { code: 'INVALID_MODE' });
  await assert.rejects(client.run(Buffer.from('not image')), { code: 'UNSUPPORTED_FILE' });
  await assert.rejects(client.run(Buffer.alloc(25 * 1024 * 1024 + 1)), { code: 'UPLOAD_SIZE' });
  assert.equal(calls.length, 0);
});
test('a saved job the service no longer knows is discarded and resubmitted once', async t => {
  const key = cacheKey(PNG, { mode: 'screen', pageRanges: '', token: TOKEN });
  let posts = 0;
  const f = await fixture(t, { send: async (url, req) => {
    if (req.method === 'POST') { posts++; return { status: 200, text: `{"data":{"jobId":"fresh-job-${posts}"}}` }; }
    if (url === resultUrl) return { status: 200, text: row('recovered') };
    if (url.endsWith('/stale-job')) return { status: 404, text: '{"code":1404,"msg":"no such job"}' };
    return { status: 200, text: JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: resultUrl } } }) };
  } });
  await fs.writeFile(path.join(f.config.cacheDir, `${key}.job.json`), JSON.stringify({ jobId: 'stale-job', savedAt: 1000000 }));
  const result = await f.client.run(PNG);
  assert.equal(result.text, 'recovered');
  assert.equal(posts, 1);
  assert.deepEqual(await fs.readdir(f.config.cacheDir), [`${key}.json`]);
});
test('local cache and checkpoint failures never hide a finished OCR result', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-ocr-blocked-cache-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const blocker = path.join(root, 'blocker');
  await fs.writeFile(blocker, 'a regular file where the cache directory should be');
  let posts = 0;
  const f = await fixture(t, { config: { cacheDir: path.join(blocker, 'cache') }, send: async (url, req) => {
    if (req.method === 'POST') { posts++; return { status: 200, text: '{"data":{"jobId":"persist-job"}}' }; }
    if (url === resultUrl) return { status: 200, text: row('persisted anyway') };
    return { status: 200, text: JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: resultUrl } } }) };
  } });
  assert.equal((await f.client.run(PNG)).text, 'persisted anyway');
  assert.equal(posts, 1);
});
test('cancelling a waiting call never submits and leaves the running call intact', async t => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  let posts = 0;
  const f = await fixture(t, { send: async (url, req) => {
    if (req.method === 'POST') { posts++; return { status: 200, text: `{"data":{"jobId":"job-${posts}"}}` }; }
    if (url === resultUrl) return { status: 200, text: row('finished') };
    if (posts === 1) await firstGate;
    return { status: 200, text: JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: resultUrl } } }) };
  } });
  const first = f.client.run(PNG);
  await new Promise(resolve => setImmediate(resolve));
  const controller = new AbortController();
  const second = f.client.run(Buffer.concat([PNG, Buffer.from([7])]), { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort(new Error('cancelled'));
  await assert.rejects(second, /cancelled/);
  releaseFirst();
  assert.equal((await first).text, 'finished');
  assert.equal(posts, 1);
});
test('a cached result returns while another job is still running', async t => {
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  let posts = 0;
  const f = await fixture(t, { send: async (url, req) => {
    if (req.method === 'POST') { posts++; return { status: 200, text: `{"data":{"jobId":"job-${posts}"}}` }; }
    if (url === resultUrl) return { status: 200, text: row('cached page') };
    if (posts > 1) await slowGate;
    return { status: 200, text: JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: resultUrl } } }) };
  } });
  assert.equal((await f.client.run(PNG)).cached, false);
  const slow = f.client.run(Buffer.concat([PNG, Buffer.from([9])]));
  await new Promise(resolve => setImmediate(resolve));
  const cached = await Promise.race([f.client.run(PNG),
    new Promise((_, reject) => setTimeout(() => reject(new Error('cache lookup waited for the queue')), 500))]);
  assert.equal(cached.cached, true);
  releaseSlow();
  assert.equal((await slow).text, 'cached page');
});
test('a dropped GET connection is retried instead of failing the call', async t => {
  let gets = 0;
  const f = await fixture(t, { send: async (url, req) => {
    if (req.method === 'POST') return { status: 200, text: '{"data":{"jobId":"retry-get"}}' };
    if (url === resultUrl) return { status: 200, text: row('retried get') };
    gets++;
    if (gets === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    return { status: 200, text: JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: resultUrl } } }) };
  } });
  assert.equal((await f.client.run(PNG)).text, 'retried get');
  assert.equal(gets, 2);
});
test('transport failures normalize to a stable retriable code', () => {
  const dropped = normalizeTransportError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
  assert.equal(dropped.code, 'NETWORK_ERROR');
  assert.match(dropped.message, /ECONNRESET/);
  assert.equal(normalizeTransportError(new OcrError('rejected', 'AUTH_FAILED')).code, 'AUTH_FAILED');
  const controller = new AbortController(); controller.abort(new Error('cancelled'));
  assert.match(normalizeTransportError(new Error('ignored'), controller.signal).message, /cancelled/);
});
