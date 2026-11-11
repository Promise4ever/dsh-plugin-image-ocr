import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOptionalPayload, buildMultipart, cacheKey, createClient, markdownToText,
  parseResults } from '../lib/paddle-rest.js';
import { DEFAULTS, FORMAT_SWITCH_KEYS, normalizeConfig, unwrapConfig } from '../lib/config.js';

const PNG = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const TOKEN = 'synthetic-test-credential';
const resultUrl = 'https://ocr-test.bcebos.com/result.jsonl?signature=synthetic';

test('VL presets keep the historical screen/document layout split', () => {
  const screen = buildOptionalPayload({ model: 'PaddleOCR-VL-1.6', mode: 'screen' });
  const document = buildOptionalPayload({ model: 'PaddleOCR-VL-1.6', mode: 'document' });
  assert.equal(screen.useLayoutDetection, false);
  assert.equal(document.useLayoutDetection, true);
  assert.equal(document.useChartRecognition, true);
  assert.deepEqual(buildOptionalPayload({ model: 'PaddleOCR-VL-1.6', mode: 'raw' }), {});
});

test('explicit switches override the preset while auto keeps it', () => {
  const payload = buildOptionalPayload({ model: 'PaddleOCR-VL-1.6', mode: 'screen',
    switches: { layoutDetection: 'on', chartRecognition: 'off', sealRecognition: 'on', orientationClassify: 'auto' } });
  assert.equal(payload.useLayoutDetection, true);
  assert.equal(payload.useChartRecognition, false);
  assert.equal(payload.useSealRecognition, true);
  assert.equal('useDocOrientationClassify' in payload, true); // from the mode preset
});

test('PP-OCR models use the OCR preset family and ignore VL-only switches', () => {
  const payload = buildOptionalPayload({ model: 'PP-OCRv6', mode: 'document',
    switches: { layoutDetection: 'on', chartRecognition: 'on', textlineOrientation: 'on', docUnwarping: 'on' } });
  assert.equal(payload.useTextlineOrientation, true);
  assert.equal(payload.useDocUnwarping, true);
  assert.equal('useLayoutDetection' in payload, false);
  assert.equal('useChartRecognition' in payload, false);
});

test('multipart carries the selected model and payload', () => {
  const { body } = buildMultipart(PNG, { model: 'PP-OCRv6', payload: buildOptionalPayload({ model: 'PP-OCRv6', mode: 'screen' }) });
  const text = body.toString();
  assert.match(text, /PP-OCRv6/);
  assert.match(text, /useTextlineOrientation/);
  assert.doesNotMatch(text, /useLayoutDetection/);
});

test('cache key isolates model, result format and format switches', () => {
  const base = { mode: 'screen', pageRanges: '', token: TOKEN, model: 'PaddleOCR-VL-1.6' };
  const key = cacheKey(PNG, base);
  assert.notEqual(cacheKey(PNG, { ...base, model: 'PP-OCRv6' }), key);
  assert.notEqual(cacheKey(PNG, { ...base, outputFormat: 'text' }), key);
  assert.notEqual(cacheKey(PNG, { ...base, switches: { layoutDetection: 'on' } }), key);
});

test('PP-OCR result rows parse into text pages', () => {
  const row = (texts) => JSON.stringify({ result: { ocrResults: [{ prunedResult: { rec_texts: texts } }] } });
  assert.deepEqual(parseResults(`\uFEFF${row(['第一行', '第二行'])}\n`), { pages: 1, text: '第一行\n第二行' });
  assert.throws(() => parseResults(JSON.stringify({ result: { ocrResults: [{}] } })), { code: 'INVALID_RESULT' });
  assert.throws(() => parseResults(JSON.stringify({ result: { ocrResults: [] } })), { code: 'EMPTY_RESULT' });
});

test('text output format strips Markdown decorations from VL pages', () => {
  const row = JSON.stringify({ result: { layoutParsingResults: [{ markdown: { text: '# 标题\n\n**粗体**与[链接](https://example.invalid)\n\n```js\ncode\n```' } }] } });
  const markdown = parseResults(row);
  assert.match(markdown.text, /# 标题/);
  const text = parseResults(row, { outputFormat: 'text' });
  assert.equal(text.text, '标题\n\n粗体与链接\n\ncode');
  assert.equal(markdownToText('- 保留列表符号'), '- 保留列表符号');
});

test('normalizeConfig validates the new settings and fills defaults', () => {
  const normalized = normalizeConfig({});
  assert.equal(normalized.model, DEFAULTS.model);
  assert.equal(normalized.outputFormat, 'markdown');
  for (const key of FORMAT_SWITCH_KEYS) assert.equal(normalized[key], 'auto');
  assert.throws(() => normalizeConfig({ model: 'bad model!' }), TypeError);
  assert.throws(() => normalizeConfig({ outputFormat: 'pdf' }), TypeError);
  assert.throws(() => normalizeConfig({ layoutDetection: 'yes' }), TypeError);
  assert.equal(normalizeConfig({ model: 'PP-OCRv6', chartRecognition: 'off' }).chartRecognition, 'off');
});

test('unwrapConfig follows volatile references and nested values', () => {
  const ref = (value) => ({ get: () => value });
  assert.deepEqual(unwrapConfig({ model: ref('PP-OCRv6'), nest: ref({ mode: ref('document') }), n: 3 }),
    { model: 'PP-OCRv6', nest: { mode: 'document' }, n: 3 });
});

test('createClient reads a live config getter between runs', async () => {
  const calls = [];
  let model = 'PaddleOCR-VL-1.6';
  const client = createClient(() => ({ token: TOKEN, timeoutMs: 5000, cacheTtlDays: 0, model }),
    { resolveToken: async () => TOKEN, sleep: async () => {}, now: () => 1000,
      request: async (url, req) => {
        calls.push({ url, req });
        if (req.method === 'POST') return { status: 200, text: '{"data":{"jobId":"live-job"}}' };
        if (url === resultUrl) return { status: 200, text: JSON.stringify({ result: { ocrResults: [{ prunedResult: { rec_texts: ['x'] } }] } }) };
        return { status: 200, text: JSON.stringify({ data: { state: 'done', resultUrl: { jsonUrl: resultUrl } } }) };
      } });
  const first = await client.run(PNG, { refresh: true });
  model = 'PP-OCRv6';
  const second = await client.run(PNG, { refresh: true });
  assert.equal(first.model, 'PaddleOCR-VL-1.6');
  assert.equal(second.model, 'PP-OCRv6');
  const posts = calls.filter(call => call.req.method === 'POST');
  assert.equal(posts.length, 2);
  assert.match(posts[0].req.body.toString(), /PaddleOCR-VL-1.6/);
  assert.match(posts[1].req.body.toString(), /PP-OCRv6/);
});
