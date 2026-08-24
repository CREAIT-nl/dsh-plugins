/**
 * dsh-gen-limit — browser half.
 *
 * Registers the "Generation Concurrency" page into the Web settings panel as a
 * top-level `settings.section` nav entry. It reads/writes the host-registered
 * `dsh-gen-limit` settings namespace through the plugin-owned
 * /api/dsh-gen-limit/* routes (see lib/settings-routes.js), and lists the
 * live providers/models from the same source the conversation uses.
 *
 * Chrome comes from `@deepseek-ai/dsh-client-ui-primitives`, the shell's seed
 * module (available to any bundle exactly like `react`, with no `inject` entry
 * and no dependency), so the controls are the same Button/Input/Menu/Pill the
 * harness's own settings pages draw.
 *
 * Plain JavaScript on purpose: the loader serves this at
 * /plugins/@creait/dsh-gen-limit/client.js and calls
 * window.__ModuleLoader__.load({ id, factory }).
 */

window.__ModuleLoader__.load({
  id: '@creait/dsh-gen-limit',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    // Seed module: resolved by the shell itself, never declared as a dependency
    // or an inject. Guarded anyway — a missing primitive must degrade to the
    // plain markup below, never blank the Settings page.
    let P = {}
    try {
      P = require('@deepseek-ai/dsh-client-ui-primitives') || {}
    } catch (error) {
      P = {}
    }

    const NS = 'dsh-gen-limit'
    const CONFIG_ROUTE = '/api/dsh-gen-limit/config'
    const CATALOG_ROUTE = '/api/dsh-gen-limit/catalog'
    const STATS_ROUTE = '/api/dsh-gen-limit/stats'

    /** How long typing settles before a queue field is written. */
    const WRITE_DELAY_MS = 600

    // ---------------------------------------------------------------- locale
    const zh = {
      nav: '生成并发',
      title: 'Generation Concurrency',
      description: '按 provider/model 限制并发生成会话数；超出上限的请求排队等待，而不是失败。-1 表示不限。',
      unsaved: '未保存', readOnly: '本部署的设置为只读。',
      add: '添加限制', remove: '移除', providerLabel: 'Provider', modelLabel: 'Model',
      maxLabel: 'Max 并发', maxHint: '-1 = 不限', unlimited: '不限 (-1)', active: '活跃', waiting: '排队',
      noLimits: '尚未配置任何限制（默认全部不限）。',
      hint: '达到上限时，流式调用和子代理派生都会排队等待空位，而不是被拒绝。只有等到超时才会失败，并说明原因。',
      queueHeading: '排队',
      queueTimeoutLabel: '最长等待 (ms)',
      queueTimeoutHint: '0 = 一直等',
      queueTimeoutNote: '等待超过此时长才放弃并报错。设为 0 表示永不超时——仅适用于无人值守的批处理部署。',
      maxQueuedLabel: '队列长度上限',
      maxQueuedNote: '单个 provider/model 最多可有多少请求在排队。超出后直接拒绝，避免请求无限堆积。',
    }
    const en = {
      nav: 'Generation Concurrency',
      title: 'Generation Concurrency',
      description: 'Limit concurrent generating sessions per provider/model. Anything past the limit queues for a slot rather than failing (-1 = unlimited).',
      unsaved: 'Unsaved', readOnly: 'This deployment stores settings read-only.',
      add: 'Add limit', remove: 'Remove', providerLabel: 'Provider', modelLabel: 'Model',
      maxLabel: 'Max concurrency', maxHint: '-1 = unlimited', unlimited: 'Unlimited (-1)', active: 'active', waiting: 'waiting',
      noLimits: 'No limits configured yet — every provider/model is unlimited (-1).',
      hint: 'At capacity both streaming calls and subagent spawns wait in line for a slot instead of being refused. Only a wait that runs out fails, and it says why.',
      queueHeading: 'Queueing',
      queueTimeoutLabel: 'Max wait (ms)',
      queueTimeoutHint: '0 = forever',
      queueTimeoutNote: 'How long a request waits for a slot before giving up with an error. 0 never gives up — reasonable only for a batch deployment with nobody sitting in front of it.',
      maxQueuedLabel: 'Max queued',
      maxQueuedNote: 'How many requests may be in line for one provider/model. Past this, the door shuts, so a slow backend cannot pile up requests without bound.',
    }

    // ------------------------------------------------------------ snapshot
    function loadJson(url, fallback) {
      return fetch(url, { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .catch(() => fallback)
    }

    // ------------------------------------------------------------- styles
    // Metrics are the harness's own: 16px row padding over a border-l2 rule,
    // 14/22 titles, 12/18 tertiary descriptions, 36px radius-18 selectors,
    // 8px field radii. Every token used here exists in dsh-client-ui-theme, so
    // there are no fallback chains.
    const CSS =
      '.gl-section{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}' +
      '.gl-heading{margin:0;font-size:18px;font-weight:600;line-height:26px}' +
      '.gl-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}' +
      '.gl-subheading{margin:12px 0 0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}' +
      '.gl-readonly{margin:0;padding:8px 12px;border-radius:8px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}' +
      '.gl-stack{display:flex;flex-direction:column}' +
      '.gl-stack>:last-child{border-bottom:none}' +
      '.gl-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}' +
      '.gl-row-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}' +
      '.gl-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px;overflow-wrap:anywhere}' +
      '.gl-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}' +
      '.gl-add{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}' +
      '.gl-pills{display:inline-flex;align-items:center;gap:6px;flex:none}' +
      '.gl-selector{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}' +
      '.gl-selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.gl-selector:disabled{cursor:default}' +
      '.gl-selector-label{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.gl-selector-empty{color:var(--dsw-alias-label-tertiary)}' +
      '.gl-chevron{flex:none}' +
      // The Input primitive's wrap is inline-flex with no width of its own, so
      // the width lives on this holder and is handed down to whatever it wraps.
      '.gl-field{display:inline-flex;flex:none}' +
      '.gl-field>*{width:100%}' +
      '.gl-field input{width:100%;min-width:0}' +
      '.gl-num{width:96px}.gl-wide{width:120px}' +
      // Used only if the primitives module ever fails to resolve.
      '.gl-input{box-sizing:border-box;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}' +
      '.gl-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
      '.gl-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}' +
      '.gl-btn{appearance:none;font:inherit;cursor:pointer;height:36px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}' +
      '.gl-btn:disabled{cursor:not-allowed;opacity:.4}' +
      '.gl-btn-primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:transparent}'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-gen-limit/card.css"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-gen-limit/card.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // --------------------------------------------------------- primitives
    /** Pill-shaped action button; falls back to bare markup without the seed. */
    function Btn(props) {
      if (P.Button) {
        return h(P.Button, {
          type: 'button',
          variant: props.variant || 'outline',
          size: props.size || 'md',
          disabled: props.disabled,
          onClick: props.onClick,
        }, props.children)
      }
      return h('button', {
        type: 'button',
        className: props.variant === 'primary' ? 'gl-btn gl-btn-primary' : 'gl-btn',
        disabled: props.disabled,
        onClick: props.onClick,
      }, props.children)
    }

    /** Numeric field. The holder owns the width; the primitive owns the chrome. */
    function Num(props) {
      const attrs = {
        type: 'number',
        value: props.value,
        disabled: props.disabled,
        placeholder: props.placeholder,
        onChange: (e) => props.onChange(e.target.value),
      }
      return h('span', { className: props.wide ? 'gl-field gl-wide' : 'gl-field gl-num' },
        P.Input ? h(P.Input, attrs) : h('input', Object.assign({ className: 'gl-input' }, attrs)))
    }

    /**
     * The harness has no styled `<select>`: every Settings dropdown is a
     * `.selector` button plus a Menu, portalled so it is not clipped by the
     * settings panel.
     */
    function Selector(props) {
      const [open, setOpen] = React.useState(false)
      const options = props.options || []
      const disabled = !!props.disabled || options.length === 0
      const current = options.filter((o) => o.id === props.value)[0]
      if (!P.Menu) {
        return h('select', {
          className: 'gl-input',
          value: props.value,
          disabled: disabled,
          onChange: (e) => props.onChange(e.target.value),
        },
          h('option', { value: '', disabled: true }, props.placeholder),
          options.map((o) => h('option', { key: o.id, value: o.id }, o.name)))
      }
      return h(P.Menu, {
        open,
        onClose: () => setOpen(false),
        items: options.map((o) => ({ id: o.id, label: o.name })),
        selectedId: props.value,
        onSelect: (id) => { setOpen(false); if (id !== props.value) props.onChange(id) },
        align: 'end',
        portal: true,
        anchor: h('button', {
          type: 'button',
          className: 'gl-selector',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: disabled,
          onClick: () => setOpen((v) => !v),
        },
          h('span', { className: current ? 'gl-selector-label' : 'gl-selector-label gl-selector-empty' },
            current ? current.name : props.placeholder),
          P.IconChevronDownOutline14
            ? h(P.IconChevronDownOutline14, { className: 'gl-chevron' })
            : h('span', { className: 'gl-chevron', 'aria-hidden': true }, '▾')),
      })
    }

    /** Small count badge: the harness's Pill, or plain tertiary text. */
    function Count(props) {
      if (P.Pill) return h(P.Pill, null, props.children)
      return h('span', { className: 'gl-desc' }, props.children)
    }

    /** Label left, control right — the canonical settings row. */
    function Row(props) {
      return h('div', { className: 'gl-row' },
        h('div', { className: 'gl-row-text' },
          props.title === undefined ? null : h('div', { className: 'gl-title' }, props.title),
          props.desc === undefined ? null : h('div', { className: 'gl-desc' }, props.desc)),
        props.children)
    }

    // ------------------------------------------------------------ component
    function GenLimitSection(props) {
      const { t } = props
      const [view, setView] = React.useState({ status: 'unavailable', value: { limits: [] }, writable: false })
      const [catalog, setCatalog] = React.useState({ providers: [], models: {} })
      const [stats, setStats] = React.useState({})
      const [selProvider, setSelProvider] = React.useState('')
      const [selModel, setSelModel] = React.useState('')
      const [newMax, setNewMax] = React.useState('1')
      const [models, setModels] = React.useState([])

      // The two queue knobs are held as strings: '' is a half-typed field, and
      // it is not the same as 0 — 0 means "wait forever" and must never be
      // written just because the box is momentarily empty.
      const [queueText, setQueueText] = React.useState({ queueTimeoutMs: '', maxQueued: '' })
      // Seeded once from the first ready view, then client-owned. Re-seeding on
      // every view would fight the debounce: the response to a write arrives
      // mid-typing and would snap the field back to the value already sent.
      const seeded = React.useRef(false)
      const pending = React.useRef(null)
      const queued = React.useRef(null)
      const alive = React.useRef(true)

      React.useEffect(() => {
        if (seeded.current || view.status !== 'ready') return
        seeded.current = true
        const value = view.value || {}
        setQueueText({
          queueTimeoutMs: typeof value.queueTimeoutMs === 'number' ? String(value.queueTimeoutMs) : '',
          maxQueued: typeof value.maxQueued === 'number' ? String(value.maxQueued) : '',
        })
      }, [view])

      /** Write whatever the debounce is holding, now. */
      const flush = React.useCallback(() => {
        if (pending.current !== null) { clearTimeout(pending.current); pending.current = null }
        if (queued.current === null) return
        const patch = queued.current
        queued.current = null
        // No `limits` in the body: this posts only what changed, so a limits
        // edit made elsewhere in the meantime is not overwritten by the array
        // this page happened to be holding.
        fetch(CONFIG_ROUTE, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(patch),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((v) => { if (alive.current) setView(v) })
          .catch((error) => { try { console.warn('[dsh-gen-limit] queue write failed:', error) } catch (ignored) { /* no console */ } })
      }, [])

      // Flush rather than cancel on unmount: closing the settings panel within
      // the debounce window used to drop the last edit, which reads as the
      // field ignoring you at the moment you finished typing and clicked away.
      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false; flush() }
      }, [flush])

      const commitQueue = React.useCallback((patch) => {
        queued.current = Object.assign({}, queued.current, patch)
        if (pending.current !== null) clearTimeout(pending.current)
        pending.current = setTimeout(flush, WRITE_DELAY_MS)
      }, [flush])

      const onQueueChange = (key, floor) => (raw) => {
        const text = String(raw).trim()
        if (text === '') { setQueueText((prev) => Object.assign({}, prev, { [key]: '' })); return }
        const parsed = Number(text)
        if (!Number.isFinite(parsed)) return
        const clamped = Math.max(floor, Math.round(parsed))
        // Show the clamped value, not the raw one: a field reading 3.7 while
        // the limiter runs 4 is a lie about what the deployment is doing.
        setQueueText((prev) => Object.assign({}, prev, { [key]: String(clamped) }))
        commitQueue({ [key]: clamped })
      }

      const pullStats = React.useCallback(() => loadJson(STATS_ROUTE, { entries: [] }).then((s) => {
        const map = {}
        ;(s.entries || []).forEach((e) => {
          map[e.provider + '\u0000' + e.model] = { active: e.active || 0, waiting: e.waiting || 0 }
        })
        setStats(map)
      }), [])

      const refresh = React.useCallback(() => {
        loadJson(CONFIG_ROUTE, null).then((v) => v && setView(v))
        loadJson(CATALOG_ROUTE, { providers: [], models: {} }).then((c) => {
          setCatalog(c)
          setSelProvider((cur) => (cur && c.providers.some((p) => p.id === cur) ? cur : (c.providers.length ? c.providers[0].id : '')))
        })
        pullStats()
      }, [pullStats])

      React.useEffect(() => { refresh() }, [refresh])
      React.useEffect(() => {
        const id = setInterval(pullStats, 2000)
        return () => clearInterval(id)
      }, [pullStats])

      React.useEffect(() => {
        setModels(selProvider && catalog.models[selProvider] ? catalog.models[selProvider] : [])
        setSelModel('')
      }, [selProvider, catalog])

      const limits = (view.value && Array.isArray(view.value.limits)) ? view.value.limits : []
      const writable = view.writable === true

      const addRow = () => {
        if (!selProvider || !selModel) return
        const next = limits.concat([{ provider: selProvider, model: selModel, max: (Number(newMax) || -1) }])
        saveLimits(next)
        setNewMax('1')
      }
      const removeRow = (p, m) => saveLimits(limits.filter((x) => !(x.provider === p && x.model === m)))
      const updateMax = (p, m, v) => {
        const val = Number(v) || -1
        saveLimits(limits.map((x) => (x.provider === p && x.model === m ? { ...x, max: val } : x)))
      }
      const saveLimits = (next) => {
        fetch(CONFIG_ROUTE, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ limits: next }),
        })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
          .then((v) => setView(v))
          .catch(() => {})
      }

      return h('div', { className: 'gl-section' },
        h('h2', { className: 'gl-heading' }, t('title')),
        h('p', { className: 'gl-intro' }, t('description')),
        !writable ? h('p', { className: 'gl-readonly' }, t('readOnly')) : null,
        h('div', { className: 'gl-stack' },
          limits.length === 0 ? h(Row, { desc: t('noLimits') }) : null,
          limits.map((r) => {
            const k = r.provider + '\u0000' + r.model
            const live = stats[k]
            return h(Row, { key: k, title: r.provider + ' / ' + r.model },
              live == null
                ? null
                : h('span', { className: 'gl-pills' },
                    h(Count, null, t('active') + ' ' + live.active),
                    live.waiting > 0 ? h(Count, null, t('waiting') + ' ' + live.waiting) : null),
              h(Num, {
                value: String(r.max), disabled: !writable, placeholder: t('maxHint'),
                onChange: (v) => updateMax(r.provider, r.model, v),
              }),
              h(Btn, { disabled: !writable, onClick: () => removeRow(r.provider, r.model) }, t('remove')))
          }),
          h('div', { className: 'gl-add' },
            h(Selector, {
              value: selProvider, options: catalog.providers, disabled: !writable,
              placeholder: t('providerLabel'), onChange: setSelProvider,
            }),
            h(Selector, {
              value: selModel, options: models, disabled: !writable,
              placeholder: t('modelLabel'), onChange: setSelModel,
            }),
            h(Num, { value: newMax, disabled: !writable, onChange: setNewMax, placeholder: t('maxHint') }),
            h(Btn, {
              variant: 'primary', disabled: !writable || !selProvider || !selModel, onClick: addRow,
            }, t('add')))),
        h('h3', { className: 'gl-subheading' }, t('queueHeading')),
        h('p', { className: 'gl-intro' }, t('hint')),
        h('div', { className: 'gl-stack' },
          h(Row, { title: t('queueTimeoutLabel'), desc: t('queueTimeoutNote') },
            h(Num, {
              wide: true, value: queueText.queueTimeoutMs, disabled: !writable,
              placeholder: t('queueTimeoutHint'), onChange: onQueueChange('queueTimeoutMs', 0),
            })),
          h(Row, { title: t('maxQueuedLabel'), desc: t('maxQueuedNote') },
            h(Num, {
              wide: true, value: queueText.maxQueued, disabled: !writable,
              onChange: onQueueChange('maxQueued', 1),
            }))),
      )
    }

    // --------------------------------------------------------------- nav icon
    // The settings shell picks each nav glyph from a hardcoded section-id ->
    // icon map (ui-settings-general `navIcon`) and falls back to the settings
    // gear for ids it does not know, which is ours. `settings.section` carries
    // no icon option, so the only way to show a concurrency glyph is to retouch
    // the rendered one: swap the gear's path geometry for the official
    // IconBranchOutline16 path, on our row only.
    //
    // Deliberately an attribute-level mutation of the node React already
    // rendered, not a node replacement: the shell re-renders this icon with
    // unchanged props, so React diffs nothing and never restores the gear. A
    // remount (closing and reopening the panel) paints a fresh gear, which the
    // observer catches. Everything here is best-effort — if dsh moves its
    // internals, nothing matches and the row simply keeps the gear.
    const BRANCH_PATH =
      'M13.0762 1.37207C14.0846 1.37228 14.9021 2.19077 14.9023 3.19922C14.9022 4.20772 14.0847 5.02518 13.0762 5.02539C12.2967 5.02539 11.6325 4.53691 11.3701 3.84961H4.35547C4.79397 4.26458 5.15861 4.7644 5.41699 5.33496L7.10645 9.06738C7.88526 10.7875 9.55104 11.9228 11.4189 12.0371C11.7085 11.4109 12.3411 10.9756 13.0762 10.9756C14.0843 10.9759 14.9023 11.7936 14.9023 12.8018C14.9023 13.81 14.0843 14.6277 13.0762 14.6279C12.2534 14.6279 11.5574 14.0832 11.3291 13.335C8.9868 13.1879 6.89981 11.7612 5.92285 9.60352L4.23242 5.87109C3.67503 4.64033 2.44878 3.84961 1.09766 3.84961V2.54883C1.10665 2.54883 1.11601 2.54975 1.125 2.5498L11.3701 2.54883C11.6326 1.86151 12.2969 1.37207 13.0762 1.37207ZM13.0762 12.2764C12.7858 12.2764 12.5508 12.5114 12.5508 12.8018C12.5508 13.0921 12.7858 13.3281 13.0762 13.3281C13.3664 13.3279 13.6025 13.092 13.6025 12.8018C13.6025 12.5115 13.3664 12.2766 13.0762 12.2764ZM13.0762 2.67285C12.7855 2.67285 12.55 2.90861 12.5498 3.19922C12.5499 3.48987 12.7855 3.72559 13.0762 3.72559C13.3667 3.72538 13.6024 3.48975 13.6025 3.19922C13.6023 2.90874 13.3666 2.67306 13.0762 2.67285Z'
    const NAV_LABELS = [zh.nav, en.nav]

    /** Repaint our settings nav row's glyph; no-op once it is already ours. */
    function paintNavIcon() {
      const cells = document.querySelectorAll('[role="dialog"] nav button')
      for (const cell of cells) {
        if (NAV_LABELS.indexOf((cell.textContent || '').trim()) === -1) continue
        const svg = cell.querySelector('svg')
        if (svg === null || svg.dataset.glNavicon === '1') continue
        const path = svg.querySelector('path')
        if (path === null) continue
        path.setAttribute('d', BRANCH_PATH)
        path.setAttribute('fill-rule', 'evenodd')
        path.setAttribute('clip-rule', 'evenodd')
        // The gear is two paths (ring + inner dot); ours is one, so the
        // leftover dot has to go or it draws through the new glyph.
        const extra = svg.querySelectorAll('path')
        for (let i = 1; i < extra.length; i += 1) extra[i].remove()
        svg.dataset.glNavicon = '1'
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

    const inject = ['slots', 'locale']

    function apply(ctx) {
      // `register` throws when the namespace already carries this locale, which
      // is what a client reload does. It must not share a `try` with the slot
      // registration below: that turned a re-register into a missing Settings
      // page. `ctx.effect` also unregisters it when the plugin unloads.
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-gen-limit: locale')
      } catch (error) {
        console.warn('[dsh-gen-limit] locale unavailable; falling back to keys:', error)
      }
      try {
        // A dedicated, always-visible Settings page (nav entry), the same way
        // dshmarket adds its "Market" page — `settings.section` is the only
        // slot that produces a top-level Settings nav entry.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-gen-limit',
              order: 200,
              label: () => ctx.locale.bind(NS)('nav'),
              locale: NS,
            },
            GenLimitSection,
          ),
        )
      } catch (error) {
        console.warn('[dsh-gen-limit] settings card failed to mount:', error)
      }
      try {
        watchNavIcon()
      } catch (error) {
        console.warn('[dsh-gen-limit] nav icon swap unavailable:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
