/**
 * Host-side configuration for the PaddleOCR image/PDF fallback tool.
 *
 * Every option is declared exactly once here: the schemastery `Config` export in
 * `index.js` mirrors `DEFAULTS`, so a value read outside the settings UI and a
 * value written by it cannot drift apart.
 */

/** Long-document parser (markdown layout parsing results). */
export const MODEL_VL = 'PaddleOCR-VL-1.6';
/** Lightweight multi-language OCR pipeline; returns plain text lines. */
export const MODEL_OCR = 'PP-OCRv6';

/**
 * Models the settings page offers. The host keeps the list authoritative so a
 * stale client cannot invent an unsupported family split.
 */
export const MODELS = Object.freeze([
  Object.freeze({
    id: MODEL_VL,
    family: 'vl',
    label: 'PaddleOCR-VL-1.6',
    summary: '文档解析大模型：版面、表格、公式、图表、印章，输出 Markdown。',
  }),
  Object.freeze({
    id: MODEL_OCR,
    family: 'ocr',
    label: 'PP-OCRv6（小模型）',
    summary: '轻量通用 OCR：50 种语言文字行识别，速度快，无版面/表格/公式结构。',
  }),
]);
export const MODEL_IDS = Object.freeze(MODELS.map(model => model.id));
export const DEFAULT_MODEL = MODEL_VL;

/**
 * Recognised models grouped by result family. `vl` rows carry
 * `layoutParsingResults`, `ocr` rows carry `ocrResults`; unknown future model
 * ids fall back to the VL family (the API's layout result contract).
 */
export function modelFamily(model) {
  if (typeof model !== 'string') return 'vl';
  if (/^PP-OCR/i.test(model.trim())) return 'ocr';
  return 'vl';
}

/**
 * Format-analysis switches exposed by the settings page. Each switch maps to an
 * optionalPayload boolean and is only meaningful for particular model families:
 * layout/chart/seal analysis belongs to the VL parser, text-line orientation to
 * the PP-OCR pipeline. `auto` follows the selected mode preset.
 */
export const FORMAT_SWITCHES = Object.freeze({
  orientationClassify: Object.freeze({
    payload: 'useDocOrientationClassify',
    families: Object.freeze(['vl', 'ocr']),
    label: '文档方向矫正',
    hint: '自动识别并矫正 0°/90°/180°/270° 的整页方向。',
  }),
  docUnwarping: Object.freeze({
    payload: 'useDocUnwarping',
    families: Object.freeze(['vl', 'ocr']),
    label: '扭曲矫正',
    hint: '矫正褶皱、倾斜、透视变形的拍摄文档。',
  }),
  textlineOrientation: Object.freeze({
    payload: 'useTextlineOrientation',
    families: Object.freeze(['ocr']),
    label: '文本行方向矫正',
    hint: '逐行识别 0°/180°，适合倒置或旋转的截图文字。',
  }),
  layoutDetection: Object.freeze({
    payload: 'useLayoutDetection',
    families: Object.freeze(['vl']),
    label: '版面分析',
    hint: '按栏、段落、表格切块后再识别；扫描页与多栏文档建议开启。',
  }),
  chartRecognition: Object.freeze({
    payload: 'useChartRecognition',
    families: Object.freeze(['vl']),
    label: '图表识别',
    hint: '把图表内容转成结构化文本（会明显增加耗时）。',
  }),
  sealRecognition: Object.freeze({
    payload: 'useSealRecognition',
    families: Object.freeze(['vl']),
    label: '印章识别',
    hint: '识别公章/印章文字，常规文档通常无需开启。',
  }),
});
export const FORMAT_SWITCH_KEYS = Object.freeze(Object.keys(FORMAT_SWITCHES));
export const FORMAT_SWITCH_VALUES = Object.freeze(['auto', 'on', 'off']);
/**
 * Run scenes. `auto` picks the preset from the uploaded content locally
 * (PDF -> document, image -> screen); the other values force a preset and
 * `raw` sends no preset at all.
 */
export const MODES = Object.freeze(['auto', 'screen', 'document', 'raw']);
export const OUTPUT_FORMATS = Object.freeze(['markdown', 'text']);

export const DEFAULTS = Object.freeze({
  model: DEFAULT_MODEL,
  mode: 'auto',
  outputFormat: 'markdown',
  orientationClassify: 'auto',
  docUnwarping: 'auto',
  textlineOrientation: 'auto',
  layoutDetection: 'auto',
  chartRecognition: 'auto',
  sealRecognition: 'auto',
  timeoutMs: 300000,
  pollIntervalMs: 2000,
  cacheTtlDays: 30,
  hintOnReadImage: true,
  hintCooldownMs: 600000,
  tokenFile: '',
});

// Options that end up in timers/abort signals must be whole milliseconds; 1000.5 makes
// AbortSignal.timeout throw ERR_OUT_OF_RANGE after the tool has already started.
const INTEGER_OPTIONS = [['timeoutMs', 1000, 3600000], ['pollIntervalMs', 500, 30000], ['hintCooldownMs', 0, 86400000]];
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/;

/**
 * Unwrap schemastery `.volatile()` references recursively.
 *
 * Volatile config fields are stable reference objects read with `.get()`; a
 * host plugin that only reads its entry config once at mount would otherwise
 * ignore every settings change. Plain data passes through untouched so the same
 * resolver works for schema-validated entries, raw JSON and tests.
 */
export function unwrapConfig(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.get === 'function') return unwrapConfig(value.get());
  if (Array.isArray(value)) return value.map(unwrapConfig);
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = unwrapConfig(child);
  return out;
}

function invalid(key, detail) {
  return new TypeError(`Invalid ${key}: ${detail}.`);
}

export function normalizeConfig(input = {}) {
  const config = { ...DEFAULTS, ...unwrapConfig(input) };
  for (const [key, min, max] of INTEGER_OPTIONS) {
    if (!Number.isInteger(config[key]) || config[key] < min || config[key] > max)
      throw invalid(key, `expected an integer between ${min} and ${max}`);
  }
  const ttlDays = config.cacheTtlDays;
  if (!Number.isFinite(ttlDays) || ttlDays < 0 || ttlDays > 365)
    throw invalid('cacheTtlDays', 'expected a finite number between 0 and 365');
  if (typeof config.model !== 'string' || !MODEL_PATTERN.test(config.model.trim()))
    throw invalid('model', 'expected a PaddleOCR model id such as PaddleOCR-VL-1.6 or PP-OCRv6');
  config.model = config.model.trim();
  if (!MODES.includes(config.mode)) throw new TypeError('Invalid default OCR mode.');
  if (!OUTPUT_FORMATS.includes(config.outputFormat))
    throw invalid('outputFormat', 'expected "markdown" or "text"');
  for (const key of FORMAT_SWITCH_KEYS) {
    if (!FORMAT_SWITCH_VALUES.includes(config[key]))
      throw invalid(key, 'expected "auto", "on" or "off"');
  }
  if (typeof config.hintOnReadImage !== 'boolean') throw new TypeError('hintOnReadImage must be a boolean.');
  if (config.token !== undefined && typeof config.token !== 'string')
    throw invalid('token', 'expected a string');
  if (config.tokenFile !== undefined && typeof config.tokenFile !== 'string')
    throw invalid('tokenFile', 'expected a string path');
  return config;
}
