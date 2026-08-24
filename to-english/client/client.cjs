/**
 * dsh-to-english — browser half.
 *
 * Registers the "To English" settings page (the `settings.section` slot,
 * which is the only slot that produces a top-level Settings nav entry). It
 * reads/writes the host-registered `dsh-to-english` settings namespace
 * through the plugin-owned /api/dsh-to-english/* routes, lists the live
 * providers/models from the same source the conversation uses, and offers a
 * manual "translate now" trigger for already-installed plugins.
 *
 * Chrome comes from `@deepseek-ai/dsh-client-ui-primitives` — a platform seed
 * module, requirable like `react` with no inject entry and no dependency. The
 * harness's own settings pages are built out of it, so using it is what makes
 * this page look native: pill selectors + portalled menus instead of native
 * <select>, `Button` instead of hand-rolled chrome, and the shell's own row
 * metrics (16px rows, 14/22 titles, 12/18 descriptions).
 *
 * Plain JavaScript on purpose: the loader serves this at
 * /plugins/@creait/dsh-to-english/client.js and calls
 * window.__ModuleLoader__.load({ id, factory }).
 */

window.__ModuleLoader__.load({
  id: '@creait/dsh-to-english',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    // Seed module: present on this shell, but a missing primitive must never
    // blank the settings page, so every use goes through a helper that falls
    // back to the plain markup this file used to render.
    var P = null
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      console.warn('[dsh-to-english] ui primitives unavailable; using plain controls:', error)
    }
    const hasMenu = !!(P && P.Menu)
    const hasButton = !!(P && P.Button)
    const hasInput = !!(P && P.Input)

    const NS = 'dsh-to-english'
    const CONFIG_ROUTE = '/api/dsh-to-english/config'
    const CATALOG_ROUTE = '/api/dsh-to-english/catalog'
    const TRANSLATE_ROUTE = '/api/dsh-to-english/translate'
    const STATUS_ROUTE = '/api/dsh-to-english/status'

    // ---------------------------------------------------------------- locale
    const zh = {
      nav: '转英文',
      title: 'To English',
      description: '下载插件后自动将其中的中文文案/提示词改写为地道英文（一次性，安装时执行），并通过热重载让英文版立即生效。',
      enabledLabel: '启用自动翻译',
      enabledHint: '从市场安装新插件时自动翻译并热重载。',
      modelLabel: '翻译模型',
      modelHint: '复用 Settings → Models 里已配置的模型连接，无需新建。',
      providerLabel: 'Provider', modelIdLabel: 'Model',
      blindLabel: '全部翻译',
      blindHint: '连程序据以匹配的中文一并翻译：触发词、关键词表、正则内容、语言表的中文那一半。保留它们能让插件继续为中文用户工作，但在只用英文的环境里，那些词永远不会被输入，功能等于关闭。关闭本项则保留中文行为。防止模型改动代码的结构校验不受此开关影响。',
      radiusLabel: '改写余量（行）',
      radiusHint: '中文所在行的上下各多少行也允许改写。0 只改中文本身，混排段落会留下拼接感；1 允许模型顺带修好与中文相连的那半句英文。',
      promptLabel: '翻译提示词',
      promptHint: '发送给模型的指令。可自行修改，控制“地道英文版”的产出方式。',
      promptPlaceholder: '输入翻译提示词…',
      save: '保存', saved: '已保存', unsaved: '未保存', readOnly: '本部署的设置为只读。',
      manualHeading: '手动翻译',
      manualHint: '对已安装的插件立即执行一次翻译 + 热重载。',
      packageNamePlaceholder: '插件包名，如 dsh-some-plugin',
      translate: '翻译', translating: '翻译中…',
      status: '状态', lastRun: '上次运行', never: '尚未运行',
      noModel: '未选择模型（将自动使用第一个可用模型）',
      catalogEmpty: '未发现已配置的模型。请先在 Settings → Models 配置一个。',
      resultOk: '完成', resultDisabled: '已禁用', resultNoModel: '无可用模型', resultNoCjk: '没有需要翻译的中文', resultNoLlm: 'LLM 服务不可用',
      files: '个文件', resultFailed: '个失败', resultCjkLeft: '个中文字符残留', running: '正在翻译',
      enabledOn: '已开启', enabledOff: '已关闭',
    }
    const en = {
      nav: 'To English',
      title: 'To English',
      description: 'Automatically rewrite Chinese copy/prompts in downloaded plugins into natural English — once, at install — then live-reload the English version via hot reload.',
      enabledLabel: 'Enable auto-translate',
      enabledHint: 'Translate and hot-reload new plugins as they are installed from the market.',
      modelLabel: 'Translation model',
      modelHint: 'Reuses a model connection you already configured in Settings → Models. No new connection needed.',
      providerLabel: 'Provider', modelIdLabel: 'Model',
      blindLabel: 'Translate everything',
      blindHint: 'Also translate the Chinese a program matches on: trigger phrases, keyword bags, regex contents, the non-English half of a locale table. Preserving those keeps a plugin working for a Chinese speaker; on an English-only harness the phrases that would fire the feature can never be typed, so it is simply switched off. Turn this off to preserve Chinese behaviour instead. The gates that stop the model editing code are not affected either way.',
      radiusLabel: 'Rewrite margin (lines)',
      radiusHint: 'How many lines either side of a Chinese line may also be rewritten. 0 keeps the model to the Chinese itself and leaves a mixed passage reading like a graft; 1 lets it repair the English clause the Chinese was joined to. The margin never crosses a line the guards protect.',
      promptLabel: 'Translation prompt',
      promptHint: 'The instruction sent to the model. Edit it to control how the "natural English version" is produced.',
      promptPlaceholder: 'Enter the translation prompt…',
      save: 'Save', saved: 'Saved', unsaved: 'Unsaved', readOnly: 'This deployment stores settings read-only.',
      manualHeading: 'Translate now',
      manualHint: 'Run translate + hot-reload immediately on an already-installed plugin.',
      packageNamePlaceholder: 'Package name, e.g. dsh-some-plugin',
      translate: 'Translate', translating: 'Translating…',
      status: 'Status', lastRun: 'Last run', never: 'Never',
      noModel: 'No model selected (will auto-pick the first available)',
      catalogEmpty: 'No configured models found. Configure one in Settings → Models first.',
      resultOk: 'done', resultDisabled: 'disabled', resultNoModel: 'no usable model', resultNoCjk: 'nothing to translate', resultNoLlm: 'LLM service unavailable',
      files: 'file(s)', resultFailed: 'failed', resultCjkLeft: 'CJK char(s) left', running: 'Translating',
      enabledOn: 'On', enabledOff: 'Off',
    }

    // ------------------------------------------------------------ snapshot
    function loadJson(url, fallback) {
      return fetch(url, { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .catch(() => fallback)
    }

    // ------------------------------------------------------------- styles
    // The settings shell already supplies the page padding and renders sections
    // as a flat row stack, so nothing here draws a card around the page. Every
    // metric below is the harness's own: 16px rows over a border-l2 rule,
    // 14/22 titles, 12/18 descriptions, 36px/radius-18 selectors, 8px fields.
    const CSS =
      '.te-section{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}' +
      '.te-heading{margin:0;font-size:18px;font-weight:600;line-height:26px}' +
      '.te-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}' +
      '.te-rows{display:flex;flex-direction:column}' +
      '.te-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}' +
      '.te-rows>:last-child{border-bottom:none}' +
      '.te-rowtext{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}' +
      '.te-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}' +
      '.te-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}' +
      '.te-controls{display:flex;align-items:center;gap:8px;flex:none}' +
      '.te-selector{display:inline-flex;align-items:center;gap:12px;max-width:190px;height:36px;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}' +
      '.te-selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.te-selector:disabled{cursor:default;opacity:.4}' +
      '.te-sellabel{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}' +
      '.te-chevron{flex:none}' +
      '.te-toggle{position:relative;flex:none;width:36px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-bg-module-platform);cursor:pointer;transition:background .16s}' +
      '.te-toggle[aria-checked="true"]{background:var(--dsw-alias-button-primary-fill)}' +
      '.te-toggle:disabled{cursor:default;opacity:.4}' +
      '.te-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:999px;background:var(--dsw-alias-label-secondary);transition:transform .16s,background .16s}' +
      '.te-toggle[aria-checked="true"] .te-knob{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground)}' +
      '.te-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}' +
      '.te-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5}' +
      '.te-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}' +
      '.te-input{box-sizing:border-box;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}' +
      '.te-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
      '.te-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}' +
      '.te-textarea{box-sizing:border-box;width:100%;min-height:160px;padding:10px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);resize:vertical;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}' +
      '.te-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
      '.te-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}' +
      '.te-actions{display:flex;align-items:center;gap:12px;padding:4px 0 8px}' +
      '.te-block{display:flex;flex-direction:column;gap:8px;padding:12px 0 0;border-top:1px solid var(--dsw-alias-border-l2)}' +
      '.te-subhead{margin:0;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary)}' +
      '.te-inline{display:flex;align-items:center;gap:8px}' +
      '.te-grow{flex:1;min-width:0;display:flex}' +
      '.te-grow>*{flex:1;min-width:0}' +
      '.te-grow input{width:100%;min-width:0}' +
      '.te-status{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}' +
      '.te-mono{font-family:var(--ds-font-family-code)}' +
      '.te-error{color:var(--dsw-alias-state-error-primary)}' +
      '.te-btn{appearance:none;font:inherit;cursor:pointer;height:36px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}' +
      '.te-btn:disabled{cursor:not-allowed;opacity:.4}' +
      '.te-btn-primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:transparent}'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-to-english/card.css"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-to-english/card.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------- controls

    /** `P.Button`, or the plain button this file used to render. */
    function Btn(props) {
      const { variant, size, className, children } = props
      if (hasButton) {
        return h(P.Button, {
          type: 'button',
          variant: variant || 'ghost',
          size: size || 'md',
          className,
          disabled: props.disabled,
          onClick: props.onClick,
        }, children)
      }
      return h('button', {
        type: 'button',
        className: 'te-btn' + (variant === 'primary' ? ' te-btn-primary' : '') + (className ? ' ' + className : ''),
        disabled: props.disabled,
        onClick: props.onClick,
      }, children)
    }

    /**
     * The harness has no styled `<select>`: every dropdown in Settings is a
     * pill-shaped `.selector` button plus a portalled `Menu` (portal is what
     * keeps it from clipping inside the settings panel).
     */
    function Selector(props) {
      const [open, setOpen] = React.useState(false)
      const options = props.options || []
      const current = options.filter((o) => o.id === props.value)[0]
      const label = current ? current.name : props.placeholder
      const disabled = !!props.disabled

      if (!hasMenu) {
        return h('select', {
          className: 'te-input',
          value: props.value,
          disabled,
          'aria-label': props.placeholder,
          onChange: (e) => props.onChange(e.target.value),
        },
          h('option', { value: '', disabled: true }, props.placeholder),
          options.map((o) => h('option', { key: o.id, value: o.id }, o.name)),
        )
      }

      return h(P.Menu, {
        open,
        onClose: () => setOpen(false),
        items: options.map((o) => ({ id: o.id, label: o.name })),
        selectedId: props.value,
        onSelect: (id) => {
          setOpen(false)
          if (id !== props.value) props.onChange(id)
        },
        align: 'end',
        portal: true,
        anchor: h('button', {
          type: 'button',
          className: 'te-selector',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          'aria-label': props.placeholder,
          disabled: disabled || options.length === 0,
          onClick: () => setOpen((v) => !v),
        },
          h('span', { className: 'te-sellabel' }, label),
          P && P.IconChevronDownOutline14
            ? h(P.IconChevronDownOutline14, { className: 'te-chevron' })
            : null,
        ),
      })
    }

    // ------------------------------------------------------------ component
    function ToEnglishCard(props) {
      const t = props.t
      const [view, setView] = React.useState(null)
      const [catalog, setCatalog] = React.useState({ providers: [], models: {} })
      const [draft, setDraft] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [status, setStatus] = React.useState(null)
      const [pkgName, setPkgName] = React.useState('')
      const [translating, setTranslating] = React.useState(false)
      const [manualResult, setManualResult] = React.useState(null)

      React.useEffect(() => {
        loadJson(CONFIG_ROUTE, null).then((v) => {
          if (!v) return
          setView(v)
          setDraft({
            enabled: v.value?.enabled !== false,
            provider: v.value?.provider || '',
            model: v.value?.model || '',
            prompt: v.value?.prompt || '',
            rewriteRadius: Number.isFinite(Number(v.value?.rewriteRadius)) ? Number(v.value.rewriteRadius) : 1,
            translateEverything: v.value?.translateEverything !== false,
          })
        })
        loadJson(CATALOG_ROUTE, { providers: [], models: {} }).then(setCatalog)
        loadJson(STATUS_ROUTE, null).then(setStatus)
      }, [])

      const setField = (key, value) => {
        setDraft((d) => ({ ...d, [key]: value }))
        setDirty(true)
      }

      const save = () => {
        if (!draft) return
        setSaving(true)
        fetch(CONFIG_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(draft),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((v) => { setView(v); setDirty(false); setSaving(false) })
          .catch(() => setSaving(false))
      }

      const translateNow = () => {
        const name = pkgName.trim()
        if (!name || translating) return
        setTranslating(true)
        setManualResult(null)
        fetch(TRANSLATE_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ packageName: name }),
        })
          .then((r) => r.json())
          .then((body) => {
            setManualResult(body)
            setTranslating(false)
            loadJson(STATUS_ROUTE, null).then(setStatus)
          })
          .catch((e) => { setManualResult({ ok: false, error: String(e) }); setTranslating(false) })
      }

      // A run that translated nothing used to render as "nothing to translate",
      // which is also what a run that failed on every file looked like. Report
      // the failures and the Chinese still left instead.
      const resultLabel = (report) => {
        if (!report) return ''
        if (report.status === 'done') {
          const n = (report.translated || []).length
          const failed = (report.errors || []).length
          if (n === 0 && failed === 0) return t('resultNoCjk')
          const parts = [`${t('resultOk')} (${n} ${t('files')}`]
          if (report.reload) parts.push(`reload=${report.reload}`)
          if (failed > 0) parts.push(`${failed} ${t('resultFailed')}`)
          if (report.cjkRemaining > 0) parts.push(`${report.cjkRemaining} ${t('resultCjkLeft')}`)
          return `${parts.join(', ')})`
        }
        if (report.status === 'disabled') return t('resultDisabled')
        if (report.status === 'no-model') return t('resultNoModel')
        if (report.status === 'no-llm') return t('resultNoLlm')
        return report.status || String(report.error || '')
      }

      // The first failure, verbatim. Every silent-failure hunt in this plugin
      // came down to the reason never reaching a surface anyone reads.
      const failureDetail = (report) => {
        const first = report && report.errors && report.errors[0]
        return first ? `${first.file}: ${first.status} — ${first.message}` : ''
      }

      const readOnly = view?.writable === false
      const locked = !draft || readOnly
      const models = draft && catalog.models[draft.provider] ? catalog.models[draft.provider] : []
      const enabled = draft ? draft.enabled : true
      const radius = draft ? draft.rewriteRadius : 1
      const blind = draft ? draft.translateEverything !== false : true
      const radiusOptions = [0, 1, 2, 3, 4, 5].map((n) => ({ id: String(n), name: String(n) }))
      const lastRun = status && status.lastRun ? `${status.lastRun.packageName} · ${resultLabel(status.lastRun.report)}` : t('never')
      const modelDesc = catalog.providers.length === 0
        ? t('catalogEmpty')
        : (draft && !draft.provider ? t('noModel') : t('modelHint'))

      return h('div', { className: 'te-section' },
        h('h2', { className: 'te-heading' }, t('title')),
        h('p', { className: 'te-intro' }, t('description')),

        h('div', { className: 'te-rows' },
          // enabled toggle
          h('div', { className: 'te-row' },
            h('div', { className: 'te-rowtext' },
              h('div', { className: 'te-title' }, t('enabledLabel')),
              h('div', { className: 'te-desc' }, t('enabledHint'))),
            h('div', { className: 'te-controls' },
              h('button', {
                type: 'button',
                className: 'te-toggle',
                role: 'switch',
                'aria-checked': enabled ? 'true' : 'false',
                'aria-label': t('enabledLabel'),
                title: enabled ? t('enabledOn') : t('enabledOff'),
                disabled: locked,
                onClick: () => setField('enabled', !enabled),
              }, h('span', { className: 'te-knob' })))),

          // model picker
          h('div', { className: 'te-row' },
            h('div', { className: 'te-rowtext' },
              h('div', { className: 'te-title' }, t('modelLabel')),
              h('div', { className: 'te-desc' }, modelDesc)),
            h('div', { className: 'te-controls' },
              h(Selector, {
                value: draft ? draft.provider : '',
                disabled: locked,
                placeholder: t('providerLabel'),
                options: catalog.providers,
                onChange: (v) => { setField('provider', v); setField('model', '') },
              }),
              h(Selector, {
                value: draft ? draft.model : '',
                disabled: locked || !(draft && draft.provider),
                placeholder: t('modelIdLabel'),
                options: models,
                onChange: (v) => setField('model', v),
              }))),

          // rewrite margin
          h('div', { className: 'te-row' },
            h('div', { className: 'te-rowtext' },
              h('div', { className: 'te-title' }, t('radiusLabel')),
              h('div', { className: 'te-desc' }, t('radiusHint'))),
            h('div', { className: 'te-controls' },
              h(Selector, {
                value: String(radius),
                disabled: locked,
                placeholder: t('radiusLabel'),
                options: radiusOptions,
                onChange: (v) => {
                  const n = Math.floor(Number(v))
                  setField('rewriteRadius', Number.isFinite(n) ? Math.min(5, Math.max(0, n)) : 1)
                },
              }))),

          // translate-everything: whether Chinese the program acts on is
          // translated too. Nothing here touches the structure gate.
          h('div', { className: 'te-row' },
            h('div', { className: 'te-rowtext' },
              h('div', { className: 'te-title' }, t('blindLabel')),
              h('div', { className: 'te-desc' }, t('blindHint'))),
            h('div', { className: 'te-controls' },
              h('button', {
                type: 'button',
                className: 'te-toggle',
                role: 'switch',
                'aria-checked': blind ? 'true' : 'false',
                'aria-label': t('blindLabel'),
                disabled: locked,
                onClick: () => setField('translateEverything', !blind),
              }, h('span', { className: 'te-knob' })))),
        ),

        // prompt editor — a long value, so the stacked field grammar
        h('div', { className: 'te-field' },
          h('div', { className: 'te-label' }, t('promptLabel')),
          h('p', { className: 'te-hint' }, t('promptHint')),
          h('textarea', {
            className: 'te-textarea',
            value: draft ? draft.prompt : '',
            disabled: locked,
            placeholder: t('promptPlaceholder'),
            onChange: (e) => setField('prompt', e.target.value),
          })),

        // save
        h('div', { className: 'te-actions' },
          h(Btn, {
            variant: 'primary',
            disabled: !dirty || saving || readOnly,
            onClick: save,
          }, saving ? t('saved') : (dirty ? t('save') : t('saved'))),
          readOnly ? h('span', { className: 'te-status' }, t('readOnly')) : null,
        ),

        // manual translate
        h('div', { className: 'te-block' },
          h('h3', { className: 'te-subhead' }, t('manualHeading')),
          h('p', { className: 'te-hint' }, t('manualHint')),
          h('div', { className: 'te-inline' },
            h('div', { className: 'te-grow' },
              hasInput
                ? h(P.Input, {
                    value: pkgName,
                    placeholder: t('packageNamePlaceholder'),
                    'aria-label': t('packageNamePlaceholder'),
                    style: { flex: 1 },
                    onChange: (e) => setPkgName(e.target.value),
                  })
                : h('input', {
                    className: 'te-input',
                    value: pkgName,
                    placeholder: t('packageNamePlaceholder'),
                    'aria-label': t('packageNamePlaceholder'),
                    onChange: (e) => setPkgName(e.target.value),
                  })),
            h(Btn, {
              variant: 'primary',
              disabled: !pkgName.trim() || translating,
              onClick: translateNow,
            }, translating ? t('translating') : t('translate'))),
          manualResult ? h('p', { className: 'te-status' }, resultLabel(manualResult)) : null,
          manualResult && failureDetail(manualResult)
            ? h('p', { className: 'te-status te-mono te-error', role: 'alert' }, failureDetail(manualResult))
            : null,
        ),

        // status
        h('div', { className: 'te-block' },
          h('h3', { className: 'te-subhead' }, t('status')),
          h('p', { className: 'te-status' }, `${t('lastRun')}: ${lastRun}`),
          status && status.running
            ? h('p', { className: 'te-status' }, `${t('running')}: ${status.running.packageName} ${status.running.done}/${status.running.total} ${status.running.file || ''}`)
            : null,
        ),
      )
    }

    // --------------------------------------------------------------- nav icon
    // The settings shell picks each nav glyph from a hardcoded section-id ->
    // icon map and falls back to the settings gear for ids it does not know,
    // which is ours. `settings.section` carries no icon option, so the only way
    // to show a rewrite glyph is to retouch the rendered one: swap the gear's
    // geometry for the official IconListPenOutline16 markup — a page with a pen
    // over it, which is what this plugin does to a package — on our row only.
    //
    // Deliberately an attribute-level mutation of the node React already
    // rendered, not a node replacement: the shell re-renders this icon with
    // unchanged props, so React diffs nothing and never restores the gear. A
    // remount (closing and reopening the panel) paints a fresh gear, which the
    // observer catches. Everything here is best-effort — if dsh moves its
    // internals, nothing matches and the row simply keeps the gear.
    const LISTPEN_ICON =
      '<path d="M10.8239 3.54733V4.78443H4.63437V3.54733H10.8239Z" fill="currentColor"/><path d="M10.8239 6.12629V7.36338H4.63437V6.12629H10.8239Z" fill="currentColor"/><path d="M9.073 8.70524V9.94234H4.63437V8.70524H9.073Z" fill="currentColor"/><path d="M9.13321 0.573526C10.0076 0.573525 10.7179 0.572522 11.285 0.63397C11.8645 0.696791 12.3743 0.831648 12.8193 1.1548C13.0776 1.34246 13.3056 1.57047 13.4933 1.82875C13.8164 2.2737 13.9513 2.7836 14.0141 3.36303C14.0755 3.93015 14.0745 4.64049 14.0745 5.51485V6.1757L12.7327 7.5629V5.51485C12.7327 4.61092 12.732 3.9862 12.6803 3.5081C12.6298 3.0427 12.5379 2.79497 12.4083 2.61654C12.3033 2.47211 12.176 2.34472 12.0315 2.23977C11.8531 2.11016 11.6054 2.01823 11.14 1.96777C10.6618 1.91601 10.0372 1.91539 9.13321 1.91539H6.32658C5.42262 1.91539 4.79796 1.91604 4.31983 1.96777C3.85451 2.01819 3.60672 2.11029 3.42827 2.23977C3.28392 2.34465 3.15643 2.47223 3.0515 2.61654C2.9219 2.79496 2.82997 3.04274 2.7795 3.5081C2.72774 3.9862 2.72712 4.61092 2.72712 5.51485V10.023C2.72712 10.9273 2.72773 11.5525 2.7795 12.0307C2.82992 12.4959 2.92205 12.7429 3.0515 12.9213C3.15645 13.0657 3.28384 13.1931 3.42827 13.2981C3.60676 13.4277 3.85408 13.5206 4.31983 13.5711C4.79797 13.6228 5.42259 13.6234 6.32658 13.6234H6.87057L5.57707 14.9593C5.03527 14.9556 4.57031 14.9467 4.17476 14.9039C3.59508 14.841 3.08558 14.7063 2.64048 14.383C2.38215 14.1953 2.15422 13.9684 1.96653 13.7101C1.64319 13.2649 1.50851 12.7546 1.4457 12.1748C1.38432 11.6076 1.38525 10.8974 1.38525 10.023V5.51485C1.38525 4.64049 1.38426 3.93015 1.4457 3.36303C1.50853 2.78363 1.64341 2.27368 1.96653 1.82875C2.15417 1.57059 2.38228 1.34239 2.64048 1.1548C3.08544 0.831805 3.59533 0.696762 4.17476 0.63397C4.74193 0.572552 5.45218 0.573525 6.32658 0.573526H9.13321Z" fill="currentColor"/><path d="M14.2193 14.9553H10.0124L11.3744 13.6134H14.2193V14.9553Z" fill="currentColor"/><path d="M8.24493 13.3711L7.49015 14.8806C7.40148 15.058 7.58961 15.2461 7.76695 15.1574L9.27651 14.4027L14.6147 9.09934L13.5832 8.06775L8.24493 13.3711Z" fill="currentColor"/>'
    const NAV_LABELS = [zh.nav, en.nav]

    /** Repaint our settings nav row's glyph; no-op once it is already ours. */
    function paintNavIcon() {
      const cells = document.querySelectorAll('[role="dialog"] nav button')
      for (const cell of cells) {
        if (NAV_LABELS.indexOf((cell.textContent || '').trim()) === -1) continue
        const svg = cell.querySelector('svg')
        if (svg === null || svg.dataset.teNavicon === '1') continue
        // Six paths against the gear's two, so the whole child list is
        // replaced rather than retouched path by path — leave any of the
        // gear's own paths behind and they draw through the new glyph.
        svg.setAttribute('viewBox', '0 0 16 16')
        svg.innerHTML = LISTPEN_ICON
        svg.dataset.teNavicon = '1'
      }
    }

    /** Keep repainting across panel mounts; coalesced to one pass per frame. */
    function watchNavIcon() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return
      let queued = false
      const run = () => {
        queued = false
        try { paintNavIcon() } catch (error) { /* shell internals moved */ }
      }
      const schedule = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 16)
      new MutationObserver(() => {
        if (queued) return
        queued = true
        schedule(run)
      }).observe(document.body, { childList: true, subtree: true })
      run()
    }

    // ------------------------------------------------------------------ apply

    /** The `settings.section` page: renders the ToEnglishCard. */
    function ToEnglishSection(props) {
      return h(ToEnglishCard, props)
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-to-english: locale')
      } catch (error) {
        console.warn('[dsh-to-english] locale unavailable; falling back to keys:', error)
      }
      try {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-to-english',
              order: 210,
              label: () => ctx.locale.bind(NS)('nav'),
              locale: NS,
            },
            ToEnglishSection,
          ),
        )
      } catch (error) {
        console.warn('[dsh-to-english] settings page failed to mount:', error)
      }
      try {
        watchNavIcon()
      } catch (error) {
        console.warn('[dsh-to-english] nav icon swap unavailable:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
