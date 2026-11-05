import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const API_ORIGIN = 'https://paddleocr.aistudio-app.com';
export const JOBS_PATH = '/api/v2/ocr/jobs';
export const MODEL = 'PaddleOCR-VL-1.6';
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CACHE_VERSION = 2;
// Explicit agent: never inherit NODE_USE_ENV_PROXY or the host's globalAgent.
const directAgent = new https.Agent({ keepAlive: false, proxyEnv: {} });
export const MODE_PRESETS = Object.freeze({
  screen: Object.freeze({ useDocOrientationClassify: false, useDocUnwarping: false,
    useLayoutDetection: false, useChartRecognition: true, useSealRecognition: false }),
  document: Object.freeze({ useDocOrientationClassify: false, useDocUnwarping: false,
    useLayoutDetection: true, useChartRecognition: true, useSealRecognition: false }),
  raw: Object.freeze({}),
});
export class OcrError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'OcrError';
    this.code = code;
    if (details.status !== undefined) this.status = details.status;
    if (details.cause !== undefined) this.cause = details.cause;
  }
}
/** Classify transport failures once so retry logic and callers see stable codes. */
export function normalizeTransportError(error, signal) {
  if (signal?.aborted) return signal.reason ?? new OcrError('OCR request was cancelled.', 'CANCELLED');
  if (error instanceof OcrError) return error;
  const suffix = typeof error?.code === 'string' ? ` (${error.code})` : '';
  return new OcrError(`OCR network request failed${suffix}; check network and retry.`, 'NETWORK_ERROR', { cause: error });
}
export function dshHome(env = process.env) {
  return env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
}
export async function resolveToken(config = {}, env = process.env) {
  const token = [config.token, env.PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN,
    env.AISTUDIO_ACCESS_TOKEN, env.PADDLEOCR_AISTUDIO_TOKEN]
    .find(value => typeof value === 'string' && value.trim());
  if (token) return token.trim();
  const filename = config.tokenFile || path.join(dshHome(env), 'ocr-token.txt');
  try {
    const info = await fs.stat(filename);
    if (!info.isFile() || info.size > 8192) throw new OcrError('OCR credential file must be a small regular text file.', 'TOKEN_FILE_INVALID');
    const value = (await fs.readFile(filename, 'utf8')).trim();
    if (value && !/[\r\n]/.test(value)) return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  throw new OcrError(`No aistudio credential. Configure a supported environment variable or a one-line credential file at ${filename}. Do not paste credentials into chat.`, 'NO_TOKEN');
}
export function normalizePageRanges(value = '') {
  const ranges = value.replace(/\s+/g, '');
  if (!ranges) return '';
  if (ranges.length > 128 || !/^[1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*$/.test(ranges))
    throw new OcrError('pageRanges must be one-based page numbers/ranges, such as 1-3,5.', 'INVALID_PAGE_RANGES');
  for (const range of ranges.split(',')) {
    const [a, b = a] = range.split('-').map(Number);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || b < a)
      throw new OcrError('pageRanges contains an invalid or reversed range.', 'INVALID_PAGE_RANGES');
  }
  return ranges;
}
export function mediaType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png', '.png'];
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', '.jpg'];
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return ['image/gif', '.gif'];
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return ['image/webp', '.webp'];
  if (bytes.subarray(0, 5).toString() === '%PDF-') return ['application/pdf', '.pdf'];
  if (['49492a00', '4d4d002a'].includes(bytes.subarray(0, 4).toString('hex'))) return ['image/tiff', '.tiff'];
  if (bytes.subarray(0, 2).toString() === 'BM') return ['image/bmp', '.bmp'];
  throw new OcrError('Only PNG, JPEG, GIF, WebP, TIFF, BMP and PDF content is accepted.', 'UNSUPPORTED_FILE');
}
export function buildMultipart(bytes, options) {
  const [mime, extension] = mediaType(bytes);
  const boundary = `----dsh-ocr-${randomUUID()}`;
  const fields = { model: MODEL, optionalPayload: JSON.stringify(MODE_PRESETS[options.mode]) };
  if (options.pageRanges) fields.pageRanges = options.pageRanges;
  const parts = Object.entries(fields).map(([key, value]) => Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
  // Do not upload the user's original filename or local directory.
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="input${extension}"\r\nContent-Type: ${mime}\r\n\r\n`), bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
export function cacheKey(bytes, { mode, pageRanges, token }) {
  return createHash('sha256').update(bytes).update(JSON.stringify({ version: CACHE_VERSION, model: MODEL,
    options: MODE_PRESETS[mode], pageRanges, account: createHash('sha256').update(token).digest('hex') })).digest('hex');
}
export function validateResultUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new OcrError('Missing or invalid result URL.', 'INVALID_RESULT_URL'); }
  const allowed = ['aistudio-app.com', 'bcebos.com', 'baidubce.com'];
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
    !allowed.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)))
    throw new OcrError('Result URL is outside the supported HTTPS service/storage domains.', 'UNTRUSTED_RESULT_URL');
  return url.href;
}
export function parseResults(text) {
  const pages = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim())) {
    let row;
    try { row = JSON.parse(line); } catch { throw new OcrError('OCR result contains invalid JSONL.', 'INVALID_RESULT'); }
    const blocks = row?.result?.layoutParsingResults ?? row?.layoutParsingResults;
    if (!Array.isArray(blocks)) throw new OcrError('OCR result is missing layoutParsingResults.', 'INVALID_RESULT');
    for (const block of blocks) {
      if (typeof block?.markdown?.text !== 'string') throw new OcrError('OCR result is missing Markdown text.', 'INVALID_RESULT');
      pages.push(block.markdown.text);
    }
  }
  if (!pages.length || !pages.some(page => page.trim())) throw new OcrError('OCR returned no text.', 'EMPTY_RESULT');
  return { text: pages.join('\n\n---\n\n'), pages: pages.length };
}
export function request(url, { method = 'GET', headers = {}, body, signal, maxBytes = 20 * 1024 * 1024 } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle, value) => { if (!settled) { settled = true; settle(value); } };
    const req = https.request(url, { method, headers, agent: directAgent, signal }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) req.destroy(new OcrError('OCR response exceeded the size limit.', 'RESPONSE_TOO_LARGE'));
        else chunks.push(chunk);
      });
      // A stream that errors or closes early must surface as a retriable transport failure.
      res.on('error', error => finish(reject, normalizeTransportError(error, signal)));
      res.on('close', () => {
        if (!res.complete) finish(reject, normalizeTransportError(new Error('OCR response stream closed before completion'), signal));
      });
      res.on('end', () => finish(resolve, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', error => finish(reject, normalizeTransportError(error, signal)));
    if (body) req.write(body);
    req.end();
  });
}
async function readJson(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch { return undefined; }
}
async function saveJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = `${filename}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, filename); }
  finally { await fs.rm(temp, { force: true }); }
}
// Cache and checkpoint writes are advisory: local storage failures must never fail a finished OCR.
async function bestEffort(action) {
  try { await action(); } catch { /* ignore local persistence failures */ }
}
const validJob = job => typeof job === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(job);

export function createClient(config = {}, deps = {}) {
  const send = deps.request || request;
  const wait = deps.sleep || ((ms, signal) => delay(ms, undefined, { signal }));
  const now = deps.now || Date.now;
  const tokenResolver = deps.resolveToken || (() => resolveToken(config));
  const cacheDir = config.cacheDir || path.join(dshHome(), 'ocr-cache');
  const ttl = (config.cacheTtlDays ?? 30) * 86400000;
  const timeoutMs = config.timeoutMs ?? 300000;
  const pollIntervalMs = config.pollIntervalMs ?? 2000;
  let nextSubmission = 0;
  let tail = Promise.resolve();
  const fresh = cached => ttl > 0 && cached?.version === CACHE_VERSION && now() >= cached.savedAt &&
    now() - cached.savedAt < ttl && typeof cached.text === 'string' && cached.text.trim() &&
    Number.isInteger(cached.pages) && cached.pages > 0;

  async function api(method, suffix, token, signal, multipart) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response;
      try {
        response = await send(`${API_ORIGIN}${JOBS_PATH}${suffix}`, { method, signal, maxBytes: 1048576,
          headers: { Authorization: `bearer ${token}`, ...(multipart ? {
            'Content-Type': multipart.contentType, 'Content-Length': multipart.body.length } : {}) }, body: multipart?.body });
      } catch (raw) {
        const error = normalizeTransportError(raw, signal);
        // Never re-submit an ambiguously accepted POST on a transport error.
        if (signal.aborted || method !== 'GET' || error.code !== 'NETWORK_ERROR' || attempt >= 3) throw error;
        await wait(Math.min(1000 * 2 ** attempt, 10000), signal); continue;
      }
      let parsed;
      try { parsed = JSON.parse(response.text); } catch { /* handled by the status gate */ }
      const throttled = response.status === 429 || parsed?.code === 12002;
      const transient = method === 'GET' && response.status >= 500;
      if ((throttled || transient) && attempt < 4) {
        const retryAfter = Number(response.headers?.['retry-after']);
        await wait(Math.min(30000, retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt), signal); continue;
      }
      if (response.status < 200 || response.status >= 300 || (parsed?.code !== undefined && parsed.code !== 0))
        throw new OcrError(`OCR API rejected ${method} (HTTP ${response.status}, code ${Number(parsed?.code) || 'unknown'}).`,
          response.status === 401 || response.status === 403 ? 'AUTH_FAILED' : throttled ? 'RATE_LIMITED' : 'API_ERROR',
          { status: response.status });
      if (!parsed?.data || typeof parsed.data !== 'object') throw new OcrError('OCR API returned an invalid job response.', 'INVALID_JOB_RESPONSE');
      return parsed.data;
    }
  }
  // Validation, credentials, key derivation and cache lookup never queue behind another OCR run.
  async function prepare(input, options, signal) {
    const bytes = Buffer.from(input);
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new OcrError('Upload must be non-empty and no larger than 25 MiB.', 'UPLOAD_SIZE');
    mediaType(bytes);
    const mode = options.mode || config.mode || 'screen';
    if (!Object.hasOwn(MODE_PRESETS, mode)) throw new OcrError('mode must be screen, document or raw.', 'INVALID_MODE');
    const pageRanges = normalizePageRanges(options.pageRanges);
    const token = await tokenResolver();
    signal.throwIfAborted();
    const key = cacheKey(bytes, { mode, pageRanges, token });
    const cacheFile = path.join(cacheDir, `${key}.json`);
    const checkpoint = path.join(cacheDir, `${key}.job.json`);
    const refresh = Boolean(options.refresh);
    if (!refresh) {
      const cached = await readJson(cacheFile);
      if (fresh(cached))
        return { bytes, mode, pageRanges, token, cacheFile, checkpoint, refresh,
          cached: { text: cached.text, pages: cached.pages, mode, model: MODEL, cached: true } };
    }
    return { bytes, mode, pageRanges, token, cacheFile, checkpoint, refresh };
  }
  async function submit({ token, mode, pageRanges, checkpoint }, bytes, signal) {
    await wait(Math.max(0, nextSubmission - now()), signal);
    nextSubmission = now() + 1200;
    const job = await api('POST', '', token, signal, buildMultipart(bytes, { mode, pageRanges }));
    if (!validJob(job.jobId)) throw new OcrError('OCR API did not return a valid job id.', 'INVALID_JOB_RESPONSE');
    await bestEffort(() => saveJson(checkpoint, { jobId: job.jobId, savedAt: now() }));
    return job.jobId;
  }
  async function execute(prepared, holder, signal, started) {
    const bytes = holder.bytes;
    holder.bytes = null;
    signal.throwIfAborted();
    if (!bytes) throw new OcrError('OCR request was cancelled while queued.', 'CANCELLED');
    const { token, mode, cacheFile, checkpoint } = prepared;
    let jobId;
    if (!prepared.refresh) {
      const saved = await readJson(checkpoint);
      if (validJob(saved?.jobId) && now() >= saved.savedAt && now() - saved.savedAt < 86400000) jobId = saved.jobId;
    }
    let resumed = Boolean(jobId);
    if (!jobId) jobId = await submit(prepared, bytes, signal);
    let status;
    for (;;) {
      try {
        status = await api('GET', `/${encodeURIComponent(jobId)}`, token, signal);
      } catch (error) {
        // A saved job the service no longer knows must not wedge every later retry.
        if (resumed && (error.status === 404 || error.status === 410)) {
          resumed = false;
          await bestEffort(() => fs.rm(checkpoint, { force: true }));
          jobId = await submit(prepared, bytes, signal);
          continue;
        }
        throw error;
      }
      if (status.state === 'done') break;
      if (status.state === 'failed') {
        await bestEffort(() => fs.rm(checkpoint, { force: true }));
        throw new OcrError('OCR job failed on the service. Retry or inspect the document.', 'JOB_FAILED');
      }
      if (!['pending', 'running'].includes(status.state)) throw new OcrError('OCR job returned an unknown state.', 'INVALID_JOB_STATE');
      resumed = false;
      await wait(pollIntervalMs, signal);
    }
    // Only download JSONL. Never send the API token to object storage or fetch images.
    const resultUrl = validateResultUrl(status.resultUrl?.jsonUrl);
    const result = await send(resultUrl, { signal });
    if (result.status < 200 || result.status >= 300) throw new OcrError(`OCR result download failed (HTTP ${result.status}).`, 'RESULT_FETCH_FAILED');
    const parsed = parseResults(result.text);
    // Local persistence is advisory: a read-only or full cache must not hide a finished result.
    if (ttl > 0) await bestEffort(() => saveJson(cacheFile, { version: CACHE_VERSION, savedAt: now(), ...parsed }));
    await bestEffort(() => fs.rm(checkpoint, { force: true }));
    return { ...parsed, mode, model: MODEL, cached: false, jobId, elapsedMs: now() - started };
  }
  async function run(input, options = {}) {
    const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(timeoutMs)]);
    signal.throwIfAborted();
    const started = now();
    const prepared = await prepare(input, options, signal);
    if (prepared.cached) return { ...prepared.cached, elapsedMs: now() - started };
    // The upload buffer lives in a releasable holder so a cancelled waiter frees it immediately.
    const holder = { bytes: prepared.bytes };
    prepared.bytes = null;
    const release = () => { holder.bytes = null; };
    // Exclusive submission/polling queue; cancelling a waiter never touches another call.
    let active = false;
    const operation = tail.catch(() => {}).then(() => { active = true; return execute(prepared, holder, signal, started); });
    tail = operation.catch(() => {});
    return new Promise((resolve, reject) => {
      // Active work settles through its cooperative signal, never a detached race.
      const abort = () => { release(); if (!active) reject(signal.reason ?? new OcrError('OCR request was cancelled.', 'CANCELLED')); };
      signal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    });
  }
  return { run };
}
