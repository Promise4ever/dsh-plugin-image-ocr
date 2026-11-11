/**
 * dsh-plugin-image-ocr — browser half.
 *
 * Registers a dedicated page inside the DSH settings panel:
 *   - aistudio access-token acquisition + a write-only token input backed by the
 *     harness credential store (`remote.credentials`), never by profile config;
 *   - model choice (document parser vs. the lightweight PP-OCRv6);
 *   - recognition-format switches and result format;
 *   - cache, timeout and hint knobs.
 *
 * Config values are read/written through `ctx.configForms.get(entryId)`, whose
 * namespace is the profile row id of this plugin. Every written field is
 * declared `.volatile()` on the host half, so a save takes effect on the next
 * OCR call without restarting the host.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-image-ocr',
  factory(require) {
    const React = (typeof window !== 'undefined' && window.React) || require('react');

    /** Profile row id = settings namespace. Mirrors cordis.patch.yml. */
    const ENTRY_IDS = ['dsh-plugin-image-ocr'];
    /** Credential-store reference; also the environment-variable name. */
    const CREDENTIAL_REF = 'PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN';
    /** Where a user obtains an aistudio access token. */
    const TOKEN_URL = 'https://aistudio.baidu.com/paddleocr/task';

    const CONFIG_KEYS = [
      'model', 'mode', 'outputFormat',
      'orientationClassify', 'docUnwarping', 'textlineOrientation',
      'layoutDetection', 'chartRecognition', 'sealRecognition',
      'timeoutMs', 'pollIntervalMs', 'cacheTtlDays',
      'hintOnReadImage', 'hintCooldownMs', 'tokenFile',
    ];
    const CLIENT_DEFAULTS = {
      model: 'PaddleOCR-VL-1.6',
      mode: 'screen',
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
    };
    const MODELS = [
      { id: 'PaddleOCR-VL-1.6', family: 'vl', label: 'PaddleOCR-VL-1.6（文档解析）',
        hint: '版面、表格、公式、图表、印章；输出 Markdown。较慢，结构最完整。' },
      { id: 'PP-OCRv6', family: 'ocr', label: 'PP-OCRv6（小模型）',
        hint: '轻量文字行识别，50 种语言，速度快；不输出版面、表格、公式结构。' },
    ];
    const SWITCHES = [
      { key: 'orientationClassify', label: '文档方向矫正', hint: '整页 0/90/180/270° 自动转正。', families: ['vl', 'ocr'] },
      { key: 'docUnwarping', label: '扭曲矫正', hint: '矫正褶皱、倾斜、透视变形的拍摄文档。', families: ['vl', 'ocr'] },
      { key: 'textlineOrientation', label: '文本行方向矫正', hint: '逐行 0/180° 转正，适合倒置截图（PP-OCR）。', families: ['ocr'] },
      { key: 'layoutDetection', label: '版面分析', hint: '按栏、段落、表格切块后再识别；扫描页建议开启。', families: ['vl'] },
      { key: 'chartRecognition', label: '图表识别', hint: '把图表转成结构化文本，明显更慢。', families: ['vl'] },
      { key: 'sealRecognition', label: '印章识别', hint: '识别公章印章文字，常规文档无需开启。', families: ['vl'] },
    ];
    const MODES = [
      { value: 'screen', label: '截图 / 界面（screen）', hint: '关闭版面切块，适合聊天截图、软件界面、手机截图。' },
      { value: 'document', label: '文档 / 扫描页（document）', hint: '开启版面分析，适合扫描件、多栏文档、PDF。' },
      { value: 'raw', label: '服务端默认（raw）', hint: '只发模型与文件，全部解析参数交给服务端默认值。' },
    ];

    const modelFamily = (id) => /^PP-OCR/i.test(String(id || '').trim()) ? 'ocr' : 'vl';
    const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

    /* ---------- tiny observable store (no framework deps) ---------- */
    const listeners = new Set();
    let state = {
      formStatus: 'pending',
      saved: { ...CLIENT_DEFAULTS },
      draft: { ...CLIENT_DEFAULTS },
      dirty: false,
      saving: false,
      saveMessage: '',
      saveError: '',
      tokenStatus: 'loading',
      tokenConfigured: false,
      tokenSource: '',
      tokenWritable: true,
      tokenDraft: '',
      tokenRevealed: false,
      tokenSaving: false,
      tokenMessage: '',
      tokenError: '',
    };
    let snapshot = state;
    const store = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    function publish(patch) {
      state = { ...state, ...patch };
      snapshot = state;
      for (const listener of [...listeners]) {
        try { listener() } catch (error) { /* a broken listener must not break the page */ }
      }
    }
    function useSnapshot() {
      if (typeof React.useSyncExternalStore === 'function')
        return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
      const [value, setValue] = React.useState(store.getSnapshot());
      React.useEffect(() => store.subscribe(() => setValue(store.getSnapshot())), []);
      return value;
    }

    /* ---------- config form plumbing ---------- */
    let form = null;
    let formSubscription = null;
    let formTimer = null;
    let boundCtx = null;
    let boundRemote = null;
    let tokenSubscription = null;
    let disposedSection = null;
    let disposed = false;

    function pickValues(source) {
      const out = {};
      for (const key of CONFIG_KEYS) {
        const fallback = CLIENT_DEFAULTS[key];
        const raw = source ? source[key] : undefined;
        if (typeof fallback === 'number') out[key] = Number.isFinite(Number(raw)) ? Number(raw) : fallback;
        else if (typeof fallback === 'boolean') out[key] = typeof raw === 'boolean' ? raw : fallback;
        else out[key] = typeof raw === 'string' && raw !== '' ? raw : (typeof raw === 'string' ? raw : fallback);
      }
      return out;
    }
    function configFormsOf(ctx) {
      try { if (ctx.configForms && typeof ctx.configForms.get === 'function') return ctx.configForms } catch { /* not installed */ }
      try { const viaGet = ctx.get('configForms'); if (viaGet && typeof viaGet.get === 'function') return viaGet } catch { /* not installed */ }
      return undefined;
    }
    function servedNamespaces(forms) {
      try {
        const describe = forms.describe && forms.describe();
        const current = describe && describe.getSnapshot && describe.getSnapshot();
        const namespaces = current && current.view && Array.isArray(current.view.namespaces) ? current.view.namespaces : [];
        return namespaces.map((entry) => entry && entry.ns).filter((ns) => typeof ns === 'string');
      } catch { return [] }
    }
    function acquireForm(ctx) {
      const forms = configFormsOf(ctx);
      if (!forms) return null;
      const served = servedNamespaces(forms).filter((ns) => /image-ocr$/.test(ns));
      const candidates = served.length > 0 ? served : ENTRY_IDS;
      for (const ns of candidates) {
        try {
          const candidate = forms.get(ns);
          const current = candidate && candidate.getSnapshot && candidate.getSnapshot();
          if (current && current.status === 'ready') return candidate;
        } catch { /* try the next candidate */ }
      }
      return null;
    }
    function syncFromForm() {
      if (!form) return;
      let current;
      try { current = form.getSnapshot() } catch { return }
      const status = (current && current.status) || 'loading';
      if (status !== 'ready' || !current.value) { publish({ formStatus: status }); return }
      const saved = pickValues(current.value);
      const draft = state.dirty ? state.draft : saved;
      publish({ formStatus: 'ready', saved, draft });
    }
    function bindFormWithRetry(ctx, attempt) {
      if (disposed || form !== null) return;
      const candidate = acquireForm(ctx);
      if (candidate !== null) {
        form = candidate;
        syncFromForm();
        try {
          const off = form.subscribe(syncFromForm);
          formSubscription = typeof off === 'function' ? off : null;
        } catch { formSubscription = null }
        return;
      }
      if (attempt < 120) formTimer = setTimeout(() => bindFormWithRetry(ctx, attempt + 1), 250);
    }

    /* ---------- credential-store plumbing ---------- */
    function credentialsOf(ctx) {
      try {
        const remote = ctx.remote;
        return remote && remote.credentials ? remote.credentials : undefined;
      } catch { return undefined }
    }
    async function loadToken(ctx) {
      const credentials = credentialsOf(ctx);
      if (!credentials || typeof credentials.describe !== 'function') {
        publish({ tokenStatus: 'unavailable', tokenConfigured: false });
        return;
      }
      try {
        const response = await credentials.describe([CREDENTIAL_REF]);
        const info = response && response.ok ? (response.value && response.value[CREDENTIAL_REF]) || (response.value || {}) : {};
        publish({
          tokenStatus: 'ready',
          tokenConfigured: Boolean(info.configured),
          tokenSource: typeof info.source === 'string' ? info.source : '',
          tokenWritable: info.writable !== false,
        });
      } catch (error) {
        publish({ tokenStatus: 'error', tokenError: String((error && error.message) || error) });
      }
    }
    async function saveToken(ctx) {
      const credentials = credentialsOf(ctx);
      const value = state.tokenDraft.trim();
      if (!credentials || typeof credentials.set !== 'function') {
        publish({ tokenError: '凭据服务未就绪，暂时无法保存 token。' });
        return;
      }
      if (!value) { publish({ tokenError: '请先粘贴 access token，再点保存。' }); return; }
      if (state.tokenSaving) return;
      publish({ tokenSaving: true, tokenError: '', tokenMessage: '' });
      try {
        const response = await credentials.set(CREDENTIAL_REF, value);
        if (response && response.ok) {
          publish({ tokenSaving: false, tokenDraft: '', tokenMessage: 'token 已保存到本机凭据库，下一次 OCR 调用立即生效。' });
          await loadToken(ctx);
        } else {
          const message = response && response.error && response.error.message;
          publish({ tokenSaving: false, tokenError: message || '宿主拒绝了这次 token 写入。' });
        }
      } catch (error) {
        publish({ tokenSaving: false, tokenError: String((error && error.message) || error) });
      }
    }
    async function removeToken(ctx) {
      const credentials = credentialsOf(ctx);
      if (!credentials || typeof credentials.unset !== 'function' || state.tokenSaving) return;
      publish({ tokenSaving: true, tokenError: '', tokenMessage: '' });
      try {
        const response = await credentials.unset(CREDENTIAL_REF);
        if (response && response.ok) {
          publish({ tokenSaving: false, tokenMessage: '已移除凭据库中的 token；环境变量或凭据文件仍可能继续提供 token。' });
          await loadToken(ctx);
        } else {
          const message = response && response.error && response.error.message;
          publish({ tokenSaving: false, tokenError: message || '宿主拒绝了这次 token 移除。' });
        }
      } catch (error) {
        publish({ tokenSaving: false, tokenError: String((error && error.message) || error) });
      }
    }

    /* ---------- config writes ---------- */
    function patchDraft(key, value) {
      const draft = { ...state.draft, [key]: value };
      let dirty = false;
      for (const field of CONFIG_KEYS) if (!eq(draft[field], state.saved[field])) { dirty = true; break }
      publish({ draft, dirty, saveMessage: '', saveError: '' });
    }
    function resetDraft() {
      publish({ draft: { ...CLIENT_DEFAULTS }, dirty: true, saveMessage: '', saveError: '' });
    }
    async function saveAll() {
      if (!form) { publish({ saveError: '设置服务尚未连接，无法保存。稍等片刻再试。' }); return }
      const ops = [];
      for (const key of CONFIG_KEYS) {
        if (!eq(state.draft[key], state.saved[key])) ops.push({ op: 'set', path: [key], value: state.draft[key] });
      }
      if (ops.length === 0) { publish({ saveMessage: '当前没有需要保存的改动。', saveError: '' }); return }
      if (state.saving) return;
      publish({ saving: true, saveMessage: '', saveError: '' });
      try {
        const accepted = await form.mutate(ops);
        if (accepted === false) {
          publish({ saving: false, saveError: '宿主拒绝了这次写入（字段不可写或版本冲突），请刷新设置页后重试。' });
          return;
        }
        publish({ saving: false, dirty: false, saveMessage: `已保存 ${ops.length} 项设置，下一次 OCR 调用立即生效。` });
      } catch (error) {
        publish({ saving: false, saveError: String((error && error.message) || error) });
      }
    }

    /* ---------- presentation ---------- */
    const h = React.createElement;
    const styles = {
      page: { width: '100%', maxWidth: '760px', minHeight: '100%', boxSizing: 'border-box',
        display: 'flex', flexDirection: 'column', gap: '14px', paddingBottom: '8px' },
      title: { margin: 0, fontSize: '18px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      intro: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-tertiary)' },
      card: { border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-lg)',
        background: 'var(--dsw-alias-bg-layer-1)', padding: '14px 16px', display: 'flex',
        flexDirection: 'column', gap: '10px', boxSizing: 'border-box' },
      cardTitle: { margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      cardSub: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', alignItems: 'flex-start', gap: '12px', padding: '10px 0',
        borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
      label: { display: 'block', fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' },
      hint: { display: 'block', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      input: { font: 'inherit', fontSize: '13px', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)', border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md)', padding: '6px 10px', minWidth: '220px', boxSizing: 'border-box' },
      button: { font: 'inherit', fontSize: '13px', color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-interactive-bg-hover)', border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md)', padding: '6px 14px', cursor: 'pointer' },
      primary: { borderColor: 'var(--dsw-alias-state-business-primary, var(--dsw-alias-border-l3))' },
      muted: { color: 'var(--dsw-alias-label-tertiary)' },
      badge: { fontSize: '11px', lineHeight: '18px', padding: '1px 8px', borderRadius: '999px',
        border: '0.5px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' },
      ok: { color: 'var(--dsw-alias-state-success-primary, #2f9e44)', borderColor: 'var(--dsw-alias-state-success-primary, #2f9e44)' },
      warn: { color: 'var(--dsw-alias-state-warn-primary, #b26a00)', borderColor: 'var(--dsw-alias-state-warn-primary, #b26a00)' },
      err: { color: 'var(--dsw-alias-state-error-primary, #c92a2a)', borderColor: 'var(--dsw-alias-state-error-primary, #c92a2a)' },
      stat: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px',
        lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      steps: { margin: '0 0 0 18px', padding: 0, fontSize: '12px', lineHeight: '20px',
        color: 'var(--dsw-alias-label-secondary)', display: 'flex', flexDirection: 'column', gap: '2px' },
      link: { color: 'var(--dsw-alias-state-business-primary, #4d6bfe)', textDecoration: 'none', wordBreak: 'break-all' },
      choice: (active) => ({ display: 'flex', gap: '8px', alignItems: 'flex-start', textAlign: 'left',
        font: 'inherit', cursor: 'pointer', padding: '9px 11px', borderRadius: 'var(--dsw-radius-md)',
        border: `1px solid ${active ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'var(--dsw-alias-border-l2)'}`,
        background: active ? 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4d6bfe) 8%, transparent)' : 'transparent',
        color: 'var(--dsw-alias-label-primary)', width: '100%', boxSizing: 'border-box' }),
      dot: (active) => ({ flex: '0 0 auto', width: '10px', height: '10px', marginTop: '5px', borderRadius: '50%',
        border: `1px solid ${active ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'var(--dsw-alias-border-l3)'}`,
        background: active ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'transparent' }),
      footer: { position: 'sticky', bottom: 0, zIndex: 2, display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', gap: '12px', padding: '12px 0 4px', flexWrap: 'wrap',
        background: 'linear-gradient(to bottom, transparent 0%, var(--dsw-alias-bg-base, var(--dsw-alias-bg-layer-1)) 55%)' },
      error: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary, #c92a2a)' },
      success: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-success-primary, #2f9e44)' },
    };

    /** One labelled control row (label/hint on the left, control on the right). */
    function Row(props) {
      return h('div', { style: styles.row }, [
        h('div', { key: 'l', style: { flex: '1 1 auto', minWidth: 0 } }, [
          h('span', { key: 't', style: styles.label }, props.label),
          props.hint ? h('span', { key: 'h', style: styles.hint }, props.hint) : null,
        ]),
        h('div', { key: 'c', style: { flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: '6px', maxWidth: '52%' } }, props.children),
      ]);
    }
    function Badge(props) {
      const tone = props.tone === 'ok' ? styles.ok : props.tone === 'warn' ? styles.warn : props.tone === 'err' ? styles.err : null;
      return h('span', { style: { ...styles.badge, ...(tone || {}) } }, props.children);
    }
    /** Small three-way selector used by the format switches. */
    function Segmented(props) {
      return h('span', { style: { display: 'inline-flex', border: '0.5px solid var(--dsw-alias-border-l3)',
        borderRadius: 'var(--dsw-radius-md)', overflow: 'hidden' } }, props.options.map((option) => h('button', {
        key: option.value,
        type: 'button',
        onClick: () => props.onChange(option.value),
        style: { font: 'inherit', fontSize: '12px', padding: '4px 10px', cursor: 'pointer', border: 'none',
          background: props.value === option.value ? 'var(--dsw-alias-state-business-primary, #4d6bfe)' : 'transparent',
          color: props.value === option.value ? 'var(--dsw-alias-label-primary-foreground, #fff)' : 'var(--dsw-alias-label-secondary)' },
      }, option.label)));
    }
    function Select(props) {
      return h('select', { value: props.value, onChange: (event) => props.onChange(event.target.value),
        style: { ...styles.input, minWidth: '240px' } },
        props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)));
    }

    function TokenSection() {
      const snap = useSnapshot();
      const ctx = boundCtx;
      const configured = snap.tokenConfigured;
      const badge = snap.tokenStatus === 'loading' ? h(Badge, null, '读取中…')
        : snap.tokenStatus === 'unavailable' ? h(Badge, { tone: 'warn' }, '凭据服务未就绪')
          : configured ? h(Badge, { tone: 'ok' }, '已配置') : h(Badge, { tone: 'warn' }, '未配置');
      return h('section', { style: styles.card, 'data-ocr-panel': 'token' }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } }, [
          h('h4', { key: 't', style: styles.cardTitle }, 'aistudio Access Token'),
          badge,
        ]),
        h('p', { key: 'sub', style: styles.cardSub }, 'OCR 使用百度 AI Studio 的 PaddleOCR 服务，需要一个 access token。token 只保存在本机凭据库，不写进 profile 配置，也不会回显到页面。'),
        h('ol', { key: 'steps', style: styles.steps }, [
          h('li', { key: 's1' }, '打开 ', h('a', { href: TOKEN_URL, target: '_blank', rel: 'noreferrer', style: styles.link }, 'PaddleOCR 任务页'), '，登录百度账号。'),
          h('li', { key: 's2' }, '在页面的「API 调用示例」区域复制 access token（一串很长的字符）。'),
          h('li', { key: 's3' }, '粘贴到下面输入框，点「保存 token」。保存后立即对下一次 OCR 生效，无需重启。'),
        ]),
        h('div', { key: 'input', style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
          h('input', {
            key: 'field',
            type: snap.tokenRevealed ? 'text' : 'password',
            value: snap.tokenDraft,
            placeholder: configured ? '已保存（重新粘贴可替换）' : '粘贴 access token',
            autoComplete: 'off',
            spellCheck: false,
            style: { ...styles.input, flex: '1 1 260px', minWidth: '220px' },
            onChange: (event) => publish({ tokenDraft: event.target.value, tokenError: '', tokenMessage: '' }),
            onKeyDown: (event) => { if (event.key === 'Enter') saveToken(ctx); },
          }),
          h('button', { key: 'reveal', type: 'button', style: styles.button,
            onClick: () => publish({ tokenRevealed: !snap.tokenRevealed }) }, snap.tokenRevealed ? '隐藏' : '显示'),
          h('button', { key: 'save', type: 'button', style: { ...styles.button, ...styles.primary },
            onClick: () => saveToken(ctx) }, snap.tokenSaving ? '保存中…' : '保存 token'),
          configured ? h('button', { key: 'remove', type: 'button', style: styles.button,
            onClick: () => removeToken(ctx) }, '移除') : null,
        ]),
        h('p', { key: 'alt', style: styles.cardSub }, '也可以不用这里的输入框：设置环境变量 ',
          h('code', null, 'PADDLEOCR_MCP_AISTUDIO_ACCESS_TOKEN'), '，或把 token 单独一行写入 ',
          h('code', null, '~/.dsh/ocr-token.txt'), '。凭据库里的值优先于环境变量与文件。'),
        snap.tokenMessage ? h('p', { key: 'msg', style: styles.success }, snap.tokenMessage) : null,
        snap.tokenError ? h('p', { key: 'err', style: styles.error }, snap.tokenError) : null,
      ]);
    }

    function ModelSection() {
      const snap = useSnapshot();
      return h('section', { style: styles.card, 'data-ocr-panel': 'model' }, [
        h('h4', { key: 't', style: styles.cardTitle }, '识别模型'),
        h('p', { key: 'sub', style: styles.cardSub }, '切换后点页面底部「保存设置」生效。文档/公式/表格优先用 VL；只需要纯文字、追求速度时用 PP-OCRv6。'),
        h('div', { key: 'choices', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          MODELS.map((model) => h('button', {
            key: model.id,
            type: 'button',
            onClick: () => patchDraft('model', model.id),
            style: styles.choice(snap.draft.model === model.id),
            'data-model': model.id,
          }, [
            h('span', { key: 'dot', style: styles.dot(snap.draft.model === model.id) }),
            h('span', { key: 'body', style: { minWidth: 0 } }, [
              h('span', { key: 'name', style: { display: 'block', fontSize: '13px', fontWeight: 500 } }, model.label),
              h('span', { key: 'hint', style: styles.hint }, model.hint),
            ]),
          ]))),
        snap.draft.model !== 'PaddleOCR-VL-1.6' && snap.draft.model !== 'PP-OCRv6'
          ? h('p', { key: 'custom', style: styles.cardSub }, '当前模型来自手动配置：', h('code', null, snap.draft.model))
          : null,
      ]);
    }

    function FormatSection() {
      const snap = useSnapshot();
      const family = modelFamily(snap.draft.model);
      const applicable = SWITCHES.filter((item) => item.families.includes(family));
      return h('section', { style: styles.card, 'data-ocr-panel': 'format' }, [
        h('h4', { key: 't', style: styles.cardTitle }, '识别与格式'),
        h('p', { key: 'sub', style: styles.cardSub }, '「自动」跟随场景预设；手动开/关会覆盖预设。开关只对当前模型的适用项生效。'),
        h(Row, { key: 'mode', label: '默认识别场景', hint: '工具调用未显式传 mode 时使用。' },
          h(Select, { value: snap.draft.mode, options: MODES.map((item) => ({ value: item.value, label: item.label })),
            onChange: (value) => patchDraft('mode', value) })),
        h(Row, { key: 'out', label: '结果格式', hint: family === 'ocr' ? 'PP-OCR 只返回文字行，此选项仅影响 VL 的 Markdown 装饰。' : 'markdown 保留版面结构；text 去掉 Markdown 装饰。' },
          h(Select, { value: snap.draft.outputFormat, options: [{ value: 'markdown', label: 'Markdown' }, { value: 'text', label: '纯文本' }],
            onChange: (value) => patchDraft('outputFormat', value) })),
        h('div', { key: 'divider', style: { ...styles.cardSub, marginTop: '2px' } }, '高级格式开关（VL 与 PP-OCR 适用项不同）'),
        ...applicable.map((item) => h(Row, { key: item.key, label: item.label, hint: item.hint },
          h(Segmented, { value: snap.draft[item.key],
            options: [{ value: 'auto', label: '自动' }, { value: 'on', label: '开' }, { value: 'off', label: '关' }],
            onChange: (value) => patchDraft(item.key, value) })),
        ),
      ]);
    }

    function AdvancedSection() {
      const snap = useSnapshot();
      const numberRow = (key, label, hint, value, onChange, min, max) => h(Row, { key, label, hint },
        h('input', { type: 'number', min, max, value, style: { ...styles.input, minWidth: '120px' },
          onChange: (event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(Math.max(min, Math.min(max, Math.round(next))));
          } }));
      return h('section', { style: styles.card, 'data-ocr-panel': 'advanced' }, [
        h('h4', { key: 't', style: styles.cardTitle }, '性能、缓存与提示'),
        numberRow('cacheTtlDays', '结果缓存', '天；0 表示不复用本地缓存。', snap.draft.cacheTtlDays,
          (value) => patchDraft('cacheTtlDays', value), 0, 365),
        numberRow('timeoutMs', '总超时', '秒；包含排队、识别与下载结果。', Math.round(snap.draft.timeoutMs / 1000),
          (value) => patchDraft('timeoutMs', value * 1000), 1, 3600),
        numberRow('pollIntervalMs', '轮询间隔', '毫秒；任务状态查询频率。', snap.draft.pollIntervalMs,
          (value) => patchDraft('pollIntervalMs', value), 500, 30000),
        numberRow('hintCooldownMs', '提示冷却', '分钟；同一 agent 两次 OCR 提示的最小间隔。', Math.round(snap.draft.hintCooldownMs / 60000),
          (value) => patchDraft('hintCooldownMs', value * 60000), 0, 1440),
        h(Row, { key: 'hint', label: '读图后提示模型', hint: 'read_image 成功后提醒模型可调用 read_image_text；关闭后不再主动提示。' },
          h(Segmented, { value: snap.draft.hintOnReadImage ? 'on' : 'off',
            options: [{ value: 'on', label: '开启' }, { value: 'off', label: '关闭' }],
            onChange: (value) => patchDraft('hintOnReadImage', value === 'on') })),
        h(Row, { key: 'tokenFile', label: '凭据文件路径', hint: '可选。凭据库已配置时以凭据库为准。' },
          h('input', { type: 'text', value: snap.draft.tokenFile, placeholder: '例如 D:\private\ocr-token.txt',
            style: { ...styles.input, minWidth: '240px' },
            onChange: (event) => patchDraft('tokenFile', event.target.value) })),
        h('p', { key: 'note', style: styles.cardSub }, '这些设置会写入当前 profile 的 cordis.patch.yml；token 不在此列。'),
      ]);
    }

    function OcrSettingsPage() {
      const snap = useSnapshot();
      const ready = snap.formStatus === 'ready';
      const statusText = ready ? (snap.dirty ? '设置服务已连接；有未保存改动。' : '设置服务已连接，改动保存到当前 profile。')
        : snap.formStatus === 'pending' ? '正在连接设置服务…'
          : snap.formStatus === 'unavailable' ? '宿主未提供本插件的配置字段（可能是旧版插件或未重启）。'
            : `设置服务状态：${snap.formStatus}`;
      const footerHint = snap.saveError ? h('p', { key: 'e', style: styles.error }, snap.saveError)
        : snap.saveMessage ? h('p', { key: 'm', style: styles.success }, snap.saveMessage)
          : h('span', { key: 'h', style: styles.cardSub }, ready ? (snap.dirty ? '有未保存改动' : '当前已与已保存设置一致') : statusText);
      return h('div', { style: styles.page, 'data-ocr-settings': '' }, [
        h('div', { key: 'head' }, [
          h('h3', { key: 't', style: styles.title }, '图片文字识别'),
          h('p', { key: 'i', style: styles.intro }, 'read_image_text 工具的凭据、模型与识别格式设置。设置只作用于本机当前 profile。'),
        ]),
        h('div', { key: 'status', style: styles.stat }, [
          ready ? h(Badge, { key: 'b', tone: 'ok' }, '设置服务已连接') : h(Badge, { key: 'b', tone: 'warn' }, '设置服务未就绪'),
          h('span', { key: 's' }, statusText),
        ]),
        h(TokenSection, { key: 'token' }),
        h(ModelSection, { key: 'model' }),
        h(FormatSection, { key: 'format' }),
        h(AdvancedSection, { key: 'advanced' }),
        h('div', { key: 'footer', style: styles.footer }, [
          footerHint,
          h('div', { key: 'btns', style: { display: 'flex', gap: '8px', flex: '0 0 auto' } }, [
            h('button', { key: 'reset', type: 'button', style: styles.button, onClick: resetDraft }, '恢复默认'),
            h('button', { key: 'save', type: 'button',
              style: { ...styles.button, ...styles.primary, fontWeight: 600, opacity: ready && snap.dirty ? 1 : 0.6 },
              disabled: !ready || !snap.dirty || snap.saving,
              onClick: saveAll }, snap.saving ? '保存中…' : '保存设置'),
          ]),
        ]),
      ]);
    }

    /* ---------- plugin entry (browser half) ---------- */
    function apply(ctx) {
      boundCtx = ctx;
      boundRemote = ctx.remote;
      disposed = false;
      bindFormWithRetry(ctx, 0);
      loadToken(ctx);
      try {
        if (boundRemote && typeof boundRemote.$on === 'function') {
          const off = boundRemote.$on('credentials/reference-updated', () => loadToken(ctx));
          tokenSubscription = typeof off === 'function' ? off : null;
        }
      } catch { tokenSubscription = null }
      try {
        disposedSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'image-ocr',
          order: 42,
          label: '图片文字识别',
        }, OcrSettingsPage));
      } catch { disposedSection = null }
      try {
        ctx.effect(() => () => {
          disposed = true;
          form = null;
          if (formTimer !== null) { try { clearTimeout(formTimer) } catch { /* no timer */ } }
          formTimer = null;
          try { if (typeof formSubscription === 'function') formSubscription() } catch { /* gone */ }
          formSubscription = null;
          try { if (typeof tokenSubscription === 'function') tokenSubscription() } catch { /* gone */ }
          tokenSubscription = null;
          try { if (typeof disposedSection === 'function') disposedSection() } catch { /* gone */ }
          disposedSection = null;
        }, 'image-ocr: settings cleanup');
      } catch { /* older client shell without ctx.effect */ }
    }

    return {
      name: 'dsh-plugin-image-ocr',
      inject: ['slots', 'remote', 'remote.credentials', 'configForms'],
      apply,
    };
  },
});
