/**
 * @creait/dsh-research-mode — browser half.
 *
 * One control: the research WIDTH pin, in the composer's tool row.
 *
 * Width is how many questions `deep_research` takes per round, and by default
 * the model picks it per call. That default is right about the topic and blind
 * to the deployment: only the person in front of the harness knows how broad a
 * brief this box should be asked for, so this puts the number where they are.
 *
 * This is NOT the concurrency control. A round is handed to the runtime whole
 * and queued by @creait/dsh-gen-limit against the backend's per-model limit, so
 * a wide round on a narrow box runs in waves rather than failing. Width buys
 * breadth of coverage; concurrency buys the time it takes.
 *
 * Empty is "auto" — no pin, the model's argument stands. Any number pins the
 * width for every subsequent call, and the tool still clamps it to the preset
 * row's `maxWidth`.
 *
 * The control renders ONLY in a session composed from the `research` preset. In
 * every other session this bundle loads, reads the session's preset, and returns
 * null — no request, no layout, no chrome.
 *
 * Plain JavaScript on purpose: the loader serves this at
 * /plugins/@creait/dsh-research-mode/client.js and calls
 * window.__ModuleLoader__.load({ id, factory }).
 */

window.__ModuleLoader__.load({
  id: '@creait/dsh-research-mode',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-research-mode'
    const CONFIG_ROUTE = '/api/dsh-research-mode/config'

    /** The preset this control belongs to; the id is the preset's directory name. */
    const PRESET_ID = 'research'

    /**
     * The input's ceiling. A UI bound only — the authoritative clamp is the
     * preset row's `maxWidth` in agent.cordis.yml, which the browser cannot see
     * (it is agent-plane config). This mirrors the shipped value; raise it here
     * too if you raise it there, or the field will refuse a width the tool
     * would have accepted.
     */
    const MAX_WIDTH = 8

    /** Debounce on the write, so holding an arrow key is one request, not ten. */
    const WRITE_DELAY_MS = 400

    /**
     * Bounded retry on the initial read. Bounded rather than endless because the
     * failures this route produces are mostly permanent — a 403 from the
     * loopback guard will be a 403 next time too — and an unbounded poll against
     * one would run for as long as the composer is open.
     */
    const LOAD_RETRIES = 3
    const LOAD_RETRY_MS = 1200

    // ---------------------------------------------------------------- locale
    const zh = {
      label: '并发',
      title: '研究并发度',
      hint: '每轮研究的问题数。留空为自动（由模型按主题决定）。填数字则固定该值，覆盖模型的选择。这决定报告的广度，不决定并发数：超出容量的研究员会排队等待，同时运行的上限由 gen-limit 的每模型并发限制决定。',
      auto: '自动',
      readOnly: '本部署的设置为只读。',
      offline: '无法读取研究宽度设置，控件已禁用。',
    }
    const en = {
      label: 'width',
      title: 'Research width',
      hint: 'Questions researched per round. Empty is auto — the model picks per call. A number pins it and overrides the model. This shapes the breadth of the report, not the load on the machine: researchers past capacity queue, and how many run at once is gen-limit\'s per-model limit.',
      auto: 'auto',
      readOnly: 'This deployment stores settings read-only.',
      offline: 'Could not read the research width setting — control disabled.',
    }

    // ------------------------------------------------------------ transport
    // Both paths resolve to null on failure so the caller stays simple, but they
    // do NOT fail silently. The route answers 403 (not loopback), 400 (bad
    // payload) and 409 (revision conflict), and collapsing those into the same
    // quiet null as an offline server made a rejected write indistinguishable
    // from an applied one — the setting simply would not stick, with nothing
    // anywhere to say why. The console line is the only place that can carry it:
    // the pill is 34px wide and has nowhere to put an error.
    function warn(method, url, detail) {
      try { console.warn('[research-mode] ' + method + ' ' + url + ' failed: ' + detail) } catch { /* no console */ }
    }

    function requestJson(method, url, body) {
      return fetch(url, {
        method: method,
        headers: body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then((r) => {
          if (r.ok) return r.json()
          // The body carries the route's own `{ error }`; report it when it is
          // there, since "403" alone does not say which guard refused.
          return r.json().then(
            (payload) => { warn(method, url, r.status + ' ' + (payload && payload.error ? payload.error : '')); return null },
            () => { warn(method, url, String(r.status)); return null },
          )
        })
        .catch((error) => { warn(method, url, String(error)); return null })
    }

    // ------------------------------------------------------------- styles
    const CSS =
      '.rw-pill{display:inline-flex;box-sizing:border-box;align-items:center;gap:4px;height:28px;padding:0 8px;border-radius:14px;' +
      'border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));background:transparent;' +
      'color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;transition:border-color .16s,color .16s}' +
      '.rw-pill:hover{color:var(--dsw-alias-label-primary)}' +
      '.rw-pill[data-pinned="1"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}' +
      '.rw-icon{flex:none;opacity:.85}' +
      '.rw-input{width:34px;box-sizing:border-box;appearance:textfield;-moz-appearance:textfield;font:inherit;' +
      'font-variant-numeric:tabular-nums;color:inherit;background:transparent;border:0;outline:0;padding:0;text-align:center}' +
      '.rw-input::-webkit-outer-spin-button,.rw-input::-webkit-inner-spin-button{appearance:none;margin:0}' +
      '.rw-input::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));opacity:1}' +
      '.rw-input:disabled{cursor:not-allowed;opacity:.55}' +
      '.rw-label{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;letter-spacing:.02em}'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-research-mode/width.css"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-research-mode/width.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** Official IconBranchOutline16 — a fan-out, which is what width sets. */
    const BRANCH_PATH = 'M13.0762 1.37207C14.0846 1.37228 14.9021 2.19077 14.9023 3.19922C14.9022 4.20772 14.0847 5.02518 13.0762 5.02539C12.2967 5.02539 11.6325 4.53691 11.3701 3.84961H4.35547C4.79397 4.26458 5.15861 4.7644 5.41699 5.33496L7.10645 9.06738C7.88526 10.7875 9.55104 11.9228 11.4189 12.0371C11.7085 11.4109 12.3411 10.9756 13.0762 10.9756C14.0843 10.9759 14.9023 11.7936 14.9023 12.8018C14.9023 13.81 14.0843 14.6277 13.0762 14.6279C12.2534 14.6279 11.5574 14.0832 11.3291 13.335C8.9868 13.1879 6.89981 11.7612 5.92285 9.60352L4.23242 5.87109C3.67503 4.64033 2.44878 3.84961 1.09766 3.84961V2.54883C1.10665 2.54883 1.11601 2.54975 1.125 2.5498L11.3701 2.54883C11.6326 1.86151 12.2969 1.37207 13.0762 1.37207ZM13.0762 12.2764C12.7858 12.2764 12.5508 12.5114 12.5508 12.8018C12.5508 13.0921 12.7858 13.3281 13.0762 13.3281C13.3664 13.3279 13.6025 13.092 13.6025 12.8018C13.6025 12.5115 13.3664 12.2766 13.0762 12.2764ZM13.0762 2.67285C12.7855 2.67285 12.55 2.90861 12.5498 3.19922C12.5499 3.48987 12.7855 3.72559 13.0762 3.72559C13.3667 3.72538 13.6024 3.48975 13.6025 3.19922C13.6023 2.90874 13.3666 2.67306 13.0762 2.67285Z'

    function BranchIcon() {
      return h('svg', {
        className: 'rw-icon', width: 13, height: 13, viewBox: '0 0 16 16',
        fill: 'currentColor', 'aria-hidden': 'true', focusable: 'false',
      }, h('path', { d: BRANCH_PATH, fillRule: 'evenodd', clipRule: 'evenodd' }))
    }

    // ---------------------------------------------------------- component
    /** Never-changing empty selector, so the hook call stays unconditional when the kit is absent. */
    const NO_SESSIONS = () => undefined

    /**
     * The width pin.
     * @param props - composed slot props: `sessionId`, the `useSessions`
     *   standard hook, and the bound `t`.
     * @returns the pill, or null outside a research session.
     */
    function ResearchWidth(props) {
      const { sessionId } = props
      const t = props.t || ((key) => key)
      const useSessions = props.useSessions || NO_SESSIONS
      const preset = useSessions((state) => state && state.byId && state.byId[sessionId] && state.byId[sessionId].agentPreset)
      const mine = preset === PRESET_ID

      // `text` is what the field shows; '' is the auto sentinel. A string rather
      // than a number because '' and 0 are the same field state and only one of
      // them is a legal `value` for a controlled number input.
      const [text, setText] = React.useState('')
      const [writable, setWritable] = React.useState(true)
      const [ready, setReady] = React.useState(false)
      const [attempt, setAttempt] = React.useState(0)
      const [offline, setOffline] = React.useState(false)

      // The debounce timer and the value it is holding, both in refs so the
      // unmount cleanup can reach them — see the flush effect below.
      const pending = React.useRef(null)
      const queued = React.useRef(null)
      const alive = React.useRef(true)

      // `attempt` is in the deps on purpose: it is the only thing that can move
      // after a failed read. Without it `ready` stays false, the deps never
      // change again, and the pill sits there showing `auto` — asserting that no
      // pin is set — when it simply never managed to ask.
      React.useEffect(() => {
        if (!mine || ready) return undefined
        let active = true
        let timer = null
        requestJson('GET', CONFIG_ROUTE).then((view) => {
          if (!active) return
          if (view === null) {
            // Out of retries: disable rather than display. An empty enabled
            // field is a claim about the stored value; a disabled one is not.
            if (attempt >= LOAD_RETRIES) { setOffline(true); setWritable(false); setReady(true); return }
            timer = setTimeout(() => { if (active) setAttempt((n) => n + 1) }, LOAD_RETRY_MS)
            return
          }
          // Already normalized server-side, so this only formats: >= 1 is a pin,
          // anything else is the auto sentinel and shows as an empty field.
          const width = view.value && typeof view.value.width === 'number' ? view.value.width : 0
          setText(width >= 1 ? String(width) : '')
          setWritable(view.writable !== false)
          setReady(true)
        })
        return () => { active = false; if (timer !== null) clearTimeout(timer) }
      }, [mine, ready, attempt])

      /** Write whatever the debounce is holding, now. */
      const flush = React.useCallback(() => {
        if (pending.current !== null) { clearTimeout(pending.current); pending.current = null }
        if (queued.current === null) return
        const next = queued.current
        queued.current = null
        requestJson('POST', CONFIG_ROUTE, { width: next }).then((view) => {
          // Only `writable` is read here, so do not gate on `view.value`: an
          // `{ status: 'unavailable', writable: false }` view carries none, and
          // bailing early would leave the input enabled while every write is
          // silently dropped. The load path already handles that shape.
          if (view === null || !alive.current) return
          setWritable(view.writable !== false)
        })
      }, [])

      // Flush on unmount instead of cancelling. Switching sessions or closing
      // the composer within WRITE_DELAY_MS of the last keystroke used to drop
      // that keystroke, which reads as the control ignoring you at exactly the
      // moment you finished typing and moved on. `alive` is cleared first so the
      // write still lands but its response sets no state on a gone component.
      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false; flush() }
      }, [flush])

      const commit = React.useCallback((next) => {
        queued.current = next
        if (pending.current !== null) clearTimeout(pending.current)
        pending.current = setTimeout(flush, WRITE_DELAY_MS)
      }, [flush])

      const onChange = React.useCallback((event) => {
        const raw = event.target.value.trim()
        if (raw === '') { setText(''); commit(0); return }
        const parsed = Number(raw)
        if (!Number.isFinite(parsed)) return
        const clamped = Math.min(MAX_WIDTH, Math.max(1, Math.round(parsed)))
        setText(String(clamped))
        commit(clamped)
      }, [commit])

      if (!mine) return null

      const pinned = text !== ''
      return h('span', {
        className: 'rw-pill',
        'data-pinned': pinned ? '1' : '0',
        title: writable ? t('title') + ' — ' + t('hint') : (offline ? t('offline') : t('readOnly')),
      },
        h(BranchIcon, { key: 'icon' }),
        h('span', { key: 'label', className: 'rw-label' }, t('label')),
        h('input', {
          key: 'input',
          className: 'rw-input',
          type: 'number',
          min: 1,
          max: MAX_WIDTH,
          step: 1,
          value: text,
          disabled: !writable,
          placeholder: t('auto'),
          'aria-label': t('title'),
          onChange: onChange,
        }),
      )
    }

    // ------------------------------------------------------------------ apply

    const inject = ['slots', 'locale']

    function apply(ctx) {
      // Registered through `effect` so a client reload disposes the namespace
      // before re-registering it. Registering bare throws the second time
      // ("already has locale zh"), and sharing a try/catch with the slot below
      // would let that throw take the control down with it — the shape that cost
      // @creait/dsh-gen-limit its whole Settings nav entry on every reload.
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'research-mode: locale')
      } catch (error) {
        console.warn('[dsh-research-mode] locale unavailable; falling back to keys:', error)
      }
      try {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.left',
              id: 'research-width',
              order: 20,
              locale: NS,
            },
            ResearchWidth,
          ),
        )
      } catch (error) {
        console.warn('[dsh-research-mode] width control failed to mount:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
