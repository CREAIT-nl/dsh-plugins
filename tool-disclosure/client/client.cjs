/**
 * dsh-tool-disclosure — browser half.
 *
 * A "Tool Disclosure" page in the Web settings panel: one switch per group, plus
 * what that group actually costs right now, measured from the live registry
 * rather than remembered from the config.
 *
 * Every tool the registry holds gets a row. The configured groups come from the
 * profile patch; everything else is discovered and bucketed by MCP server, so a
 * server that was mounted and forgotten shows up here as the thing it costs
 * instead of being invisible until someone writes a group for it.
 *
 * The switch is the whole page on purpose. Group definitions themselves are
 * authored in the profile patch — deciding which tool names belong together and
 * what to tell the model about them is editing work, not a control. What someone
 * wants to change without opening a file is narrower: whether a group stays
 * deferred, or gets advertised in full because this deployment reaches for it
 * constantly and would rather not spend the extra step.
 *
 * It reads and writes the host-registered `dsh-tool-disclosure` settings
 * namespace through the plugin-owned /api/dsh-tool-disclosure/* routes (see
 * lib/settings-routes.js).
 *
 * Plain JavaScript on purpose: the loader serves this at
 * /plugins/@creait/dsh-tool-disclosure/client.js and calls
 * window.__ModuleLoader__.load({ id, factory }).
 */

window.__ModuleLoader__.load({
  id: '@creait/dsh-tool-disclosure',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    // A platform seed module, resolvable exactly like `react` — no `inject`
    // entry, no `dsh.client.external`, no dependency. It is what the harness's
    // own settings pages are built from. Guarded anyway: a shell that ever
    // stopped seeding it should cost this page its pills, not its content.
    let P = {}
    try { P = require('@deepseek-ai/dsh-client-ui-primitives') || {} } catch (error) { P = {} }
    const Pill = P.Pill || function (props) {
      return h('span', { className: 'td-pill' + (props.className ? ' ' + props.className : '') }, props.children)
    }

    const NS = 'dsh-tool-disclosure'
    const CONFIG_ROUTE = '/api/dsh-tool-disclosure/config'
    const GROUPS_ROUTE = '/api/dsh-tool-disclosure/groups'

    // ---------------------------------------------------------------- locale
    const zh = {
      nav: '工具披露',
      title: 'Tool Disclosure',
      description: '把不常用的工具组收起来：模型只看到一行说明，需要时用 tool_search 载入完整 schema。',
      hint: '被推迟的工具依然可以调用——只是要先载入。模型的系统提示里会列出每个组能做什么，因此它知道自己拥有该能力，只是暂时不必为「怎么用」付费。',
      readOnly: '本部署的设置为只读。',
      loading: '正在读取…',
      unreachable: '读取工具注册表失败。本插件的接口只接受本机请求——请用 127.0.0.1 打开 Web 界面，而不是局域网地址。',
      empty: '当前注册表里没有任何工具。',
      groupsHeading: '工具组',
      groupsHint: '按开销从大到小排列，直接来自当前注册表：MCP 服务器的工具归到服务器名下，其余工具各自成组。默认全部完整展示。要给某一组换个名字、自定义匹配规则或写一句给模型看的说明，就在 profile patch 的 tool-disclosure 行里加 groups 条目。',
      deferOn: '已推迟',
      deferOff: '完整展示',
      toolsOne: '个工具',
      toolsMany: '个工具',
      keptNote: '（其中 %n 个由 keep 强制展示）',
      unclaimedNote: '（另有 %n 个同名工具不在该组 match 范围内，开关管不到）',
      noneMatched: '当前没有已注册的工具匹配该组。',
      savingHeading: '当前收益',
      savingNone: '当前没有任何工具被推迟——每个请求都在完整展示全部工具。',
      savedLabel: '每个请求省下',
      savedNote: 'tokens',
      deferredToolsLabel: '已推迟工具',
      ofRegistered: '共享注册表中共 %n 个',
      approx: '约 ',
      tokens: 'tokens',
      measured: '数字由当前注册表实测得出，token 数为估算值。这里读的是共享注册表：每个会话还会挂载自己模式下的工具，因此实际展示的工具比这里列出的更多。',
    }
    const en = {
      nav: 'Tool Disclosure',
      title: 'Tool Disclosure',
      description: 'Hold back the tools this deployment rarely reaches for. The model sees one line describing the group and loads the full schemas with tool_search when it needs them.',
      hint: 'A deferred tool stays callable — it just has to be loaded first. The model is told what each group can do, so it knows it has the capability; it simply stops paying for how to use it until it does.',
      readOnly: 'This deployment stores settings read-only.',
      loading: 'Reading…',
      unreachable: 'Could not read the tool registry. This plugin\'s routes answer loopback requests only — open the web UI on 127.0.0.1 rather than over the network.',
      empty: 'The registry is holding no tools at all.',
      groupsHeading: 'Tool groups',
      groupsHint: 'Costliest first, read from the live registry: an MCP server\'s tools are grouped under the server, and everything else stands alone. All advertised in full until you switch one on. To give a group its own name, its own globs or a summary written for the model, add it to groups on the tool-disclosure row of your profile patch.',
      deferOn: 'Deferred',
      deferOff: 'Always advertised',
      toolsOne: 'tool',
      toolsMany: 'tools',
      keptNote: '(%n always advertised by keep)',
      unclaimedNote: '(%n more under this name that match does not claim, so the switch does not reach them)',
      noneMatched: 'No registered tool currently matches this group.',
      savingHeading: 'What this is buying',
      savingNone: 'Nothing is deferred right now — every request advertises every tool in full.',
      savedLabel: 'Saved per request',
      savedNote: 'tokens',
      deferredToolsLabel: 'Tools deferred',
      ofRegistered: 'of %n in the shared registry',
      approx: '~',
      tokens: 'tokens',
      measured: 'Counts are measured from the live registry; token figures are estimates. That registry is the shared one — a session also mounts its own mode tools, so it advertises more than is listed here.',
    }

    // ------------------------------------------------------------- transport
    function loadJson(url, fallback) {
      return fetch(url, { headers: { accept: 'application/json' } })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .catch(() => fallback)
    }

    /** 4123 -> "4.1k". Exact below 1000: "12 tokens" should read as 12. */
    function short(n) {
      const value = Number(n) || 0
      if (value < 1000) return String(value)
      return (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
    }

    // ---------------------------------------------------------------- styles
    // The settings shell already supplies the page's padding and draws no card
    // of its own, so neither does this: a bordered box inside `.options` reads
    // as a foreign widget dropped onto the page, and its right edge clips the
    // descriptions. Everything below is the harness's own grammar — the row
    // metrics come from `dsh-client-ui-permission-presets/PermissionRow`, the
    // heading pair from its plugins page. Every token used exists; none of them
    // needs a fallback chain.
    const CSS =
      '.td-section{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}' +
      '.td-heading{margin:0;font-size:18px;font-weight:600;line-height:26px}' +
      '.td-intro{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}' +
      '.td-note{margin:0;font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-tertiary)}' +
      '.td-alert{margin:0;font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-state-error-primary)}' +
      '.td-sub{margin:8px 0 0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}' +
      '.td-rows{display:flex;flex-direction:column}' +
      '.td-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}' +
      '.td-rows>.td-row:last-child{border-bottom:none}' +
      '.td-rowtext{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}' +
      '.td-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}' +
      '.td-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}' +
      // Clamped, with the whole thing on hover: the summary is written for the
      // model, and at full length it pushes the switch it belongs to off the
      // first screenful. Same for the names of a 24-tool server.
      '.td-summary{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}' +
      '.td-names{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code);font-size:12px;line-height:18px;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}' +
      '.td-cost{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}' +
      '.td-cost b{font-weight:600;font-variant-numeric:tabular-nums}' +
      '.td-value{flex:none;font-variant-numeric:tabular-nums}' +
      // Only used when the shell stops seeding the primitives: same box Pill
      // draws, so the row does not change shape on the way down.
      '.td-pill{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:12px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}' +
      // 36x20 track, 16px knob, 16px travel, radius 999 — the metrics the
      // harness's own toggles use. Off is the module-platform fill every
      // unpressed control on these pages sits on; on is the primary button
      // fill, so a deferred group reads the same as any other engaged control.
      '.td-switch{appearance:none;flex:none;cursor:pointer;box-sizing:border-box;width:36px;height:20px;padding:0;border:none;border-radius:999px;background:var(--dsw-alias-bg-module-platform);position:relative;transition:background .16s}' +
      '.td-switch:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.td-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}' +
      '.td-switch:disabled{cursor:default;opacity:.4}' +
      '.td-switch[aria-checked="true"]{background:var(--dsw-alias-button-primary-fill)}' +
      '.td-switch[aria-checked="true"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill)}' +
      // Knob colours stay as they were traced from the shell's own switch: a
      // label-secondary thumb is what carries against the off track, and
      // label-primary-foreground is the foreground the primary fill is paired
      // with everywhere else, so the on state does not fight it on any theme.
      '.td-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .16s,background .16s}' +
      '.td-switch[aria-checked="true"] .td-knob{transform:translateX(16px);background:var(--dsw-alias-label-primary-foreground)}'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-tool-disclosure/section.css"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-tool-disclosure/section.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------- component
    function Switch(props) {
      return h('button', {
        type: 'button',
        role: 'switch',
        className: 'td-switch',
        'aria-checked': props.checked ? 'true' : 'false',
        'aria-label': props.label,
        title: props.label,
        disabled: props.disabled,
        onClick: props.onChange,
      }, h('span', { className: 'td-knob', 'aria-hidden': true }))
    }

    /** One measured group: what it claims, what it costs, and its switch. */
    function GroupRow(props) {
      const { t, group, writable, onToggle } = props
      const names = group.names || []
      const word = group.tools === 1 ? t('toolsOne') : t('toolsMany')
      // A group can hold tools its switch does not reach: an annotation whose
      // globs cover only part of the bucket its id names leaves the rest
      // listed here but out of the saving, and saying so is what stops the
      // count reading as a lie.
      const stray = group.unclaimed || 0
      const unclaimed = stray > 0 ? ' ' + t('unclaimedNote').replace('%n', String(stray)) : ''
      const cost = group.tools === 0 && group.kept === 0 && stray === 0
        ? t('noneMatched')
        : h(React.Fragment, null,
            h('b', null, String(group.tools)), ' ' + word + ' · ',
            h('b', null, t('approx') + short(group.tokens)), ' ' + t('tokens'),
            group.kept > 0 ? ' ' + t('keptNote').replace('%n', String(group.kept)) : '',
            unclaimed)
      // The host sends no summary where one would only repeat the tool names
      // below it, so there is nothing to decide here.
      // The id is the same story: a standalone tool is its own group, and
      // repeating `bash` under `bash` is noise.
      const showNames = names.length > 1 || (names.length === 1 && names[0] !== group.id)
      return h('div', { className: 'td-row' },
        h('span', { className: 'td-rowtext' },
          h('span', { className: 'td-title' }, group.id),
          group.summary ? h('span', { className: 'td-summary', title: group.summary }, group.summary) : null,
          showNames ? h('span', { className: 'td-names', title: names.join('\n') }, names.join(', ')) : null,
          h('span', { className: 'td-cost' }, cost)),
        h(Switch, {
          checked: group.deferred,
          disabled: !writable,
          label: group.deferred ? t('deferOn') : t('deferOff'),
          onChange: () => onToggle(group.id),
        }))
    }

    /**
     * One measured figure, as a setting row with the number where a control
     * would sit.
     *
     * Tiles were an invented shape: the settings panel has no card grammar for
     * a statistic, and two bordered boxes read as a widget rather than as part
     * of the page. A `Pill` is what the harness puts at the end of a row when
     * the row is reporting rather than offering something to press.
     */
    function StatRow(props) {
      return h('div', { className: 'td-row' },
        h('span', { className: 'td-rowtext' },
          h('span', { className: 'td-title' }, props.label),
          props.note ? h('span', { className: 'td-desc' }, props.note) : null),
        h(Pill, { className: 'td-value' }, props.unit ? props.value + ' ' + props.unit : props.value))
    }

    function ToolDisclosureSection(props) {
      const { t } = props
      const [data, setData] = React.useState(null)
      const [writable, setWritable] = React.useState(false)
      // Whether the last read of the measurement failed. Without it a 403 from
      // off-box, a settings service that is absent and a route that never
      // mounted all render as the loading line, and the page sits there
      // claiming to still be reading something it will never get.
      const [unreachable, setUnreachable] = React.useState(false)
      const alive = React.useRef(true)

      const refresh = React.useCallback(() => {
        loadJson(GROUPS_ROUTE, null).then((v) => {
          if (!alive.current) return
          setUnreachable(!v)
          if (v) setData(v)
        })
        loadJson(CONFIG_ROUTE, null).then((v) => { if (alive.current && v) setWritable(v.writable === true) })
      }, [])

      React.useEffect(() => {
        alive.current = true
        refresh()
        return () => { alive.current = false }
      }, [refresh])

      /**
       * Flip one group and persist the whole list.
       *
       * One list of the ids being held back, everything else advertised, so
       * the empty list is the inert plugin. Rebuilt from what is on screen
       * rather than patched into what the server last sent: it is replace-all,
       * and rebuilding it is what makes a group switched off drop out of the
       * user layer instead of lingering there as a stale id.
       */
      const toggle = React.useCallback((id) => {
        setData((prev) => {
          if (prev === null) return prev
          const groups = prev.groups.map((g) => (g.id === id ? Object.assign({}, g, { deferred: !g.deferred }) : g))
          const defer = groups.filter((g) => g.deferred).map((g) => g.id)
          fetch(CONFIG_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ defer: defer }),
          })
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            // Re-measure rather than trust the optimistic flip: what a group
            // costs is a fact about the registry, and only the host knows it.
            .then(() => { if (alive.current) refresh() })
            .catch((error) => {
              try { console.warn('[dsh-tool-disclosure] write failed:', error) } catch (ignored) { /* no console */ }
              if (alive.current) refresh()
            })
          // Optimistic: the switch moves now, the numbers settle on the
          // response. A switch that waits a round trip reads as broken.
          return Object.assign({}, prev, { groups: groups })
        })
      }, [refresh])

      const groups = data === null ? [] : data.groups
      const total = (data && data.total) || { tools: 0, tokens: 0 }
      const held = (data && data.deferred) || { tools: 0, tokens: 0 }

      return h('div', { className: 'td-section' },
        h('h2', { className: 'td-heading' }, t('title')),
        h('p', { className: 'td-intro' }, t('description')),
        h('p', { className: 'td-intro' }, t('hint')),
        !writable ? h('p', { className: 'td-note' }, t('readOnly')) : null,
        // Shown beside the numbers as well as instead of them: a read that
        // failed after one succeeded leaves what is on screen stale, and a
        // measurement is only worth reading if the page says when it stopped
        // being one.
        unreachable ? h('p', { className: 'td-alert', role: 'alert' }, t('unreachable')) : null,
        data === null
          ? (unreachable ? null : h('p', { className: 'td-note' }, t('loading')))
          : h(React.Fragment, null,
              h('h3', { className: 'td-sub' }, t('savingHeading')),
              h('div', { className: 'td-rows' },
                // No "still advertised" figure: the measurement reads the
                // shared registry, and a session mounts mode tools of its
                // own on top of it, so that number would be a guess wearing
                // a decimal point. What is held back is exact.
                // The unit rides in `unit`, not folded into `value`: the figure
                // is what anything reading this row is after.
                h(StatRow, { label: t('savedLabel'), value: t('approx') + short(held.tokens), unit: t('savedNote') }),
                h(StatRow, {
                  label: t('deferredToolsLabel'),
                  value: String(held.tools),
                  note: t('ofRegistered').replace('%n', String(total.tools)),
                })),
              held.tokens === 0 ? h('p', { className: 'td-note' }, t('savingNone')) : null,
              // One list, costliest first. Every tool the harness holds is
              // in a group whether or not anyone wrote one down, so a page
              // that split the hand-written half from the rest would be
              // showing where the config came from — which is not what
              // anyone is here to decide.
              h('h3', { className: 'td-sub' }, t('groupsHeading')),
              h('p', { className: 'td-note' }, t('groupsHint')),
              groups.length === 0
                ? h('p', { className: 'td-note' }, t('empty'))
                : h('div', { className: 'td-rows' },
                    groups.map((group) => h(GroupRow, {
                      key: group.id, t: t, group: group, writable: writable, onToggle: toggle,
                    }))),
              h('p', { className: 'td-note' }, t('measured'))))
    }

    // --------------------------------------------------------------- nav icon
    // The settings shell picks each nav glyph from a hardcoded section-id ->
    // icon map (ui-settings-general `navIcon`) and falls back to the settings
    // gear for ids it does not know, which is ours. `settings.section` carries
    // no icon option, so the only way to show a tool glyph is to retouch the
    // rendered one — and the dsh icon set has no wrench, so this ships its own
    // path drawn to the same 16-unit box as the shipped glyphs.
    //
    // Deliberately an attribute-level mutation of the node React already
    // rendered, not a node replacement: the shell re-renders this icon with
    // unchanged props, so React diffs nothing and never restores the gear. A
    // remount (closing and reopening the panel) paints a fresh gear, which the
    // observer catches. Everything here is best-effort — if dsh moves its
    // internals, nothing matches and the row simply keeps the gear.
    //
    // Drawn to the shipped glyphs' weight rather than as a solid: the dsh set
    // is an outline set, and a filled wrench sitting between the gear and the
    // branch reads as the selected row even when it is not. Ring wall and
    // handle are both ~1.5 units, which is what those glyphs stroke at, and it
    // fills the 16-unit box corner to corner the way they do.
    const WRENCH_PATH =
      'M15.00 4.96A4.10 4.10 0 0 1 8.61 8.50L2.10 15.00A0.78 0.78 0 0 1 1.00 13.90L7.50 7.39A4.10 4.10 0 0 1 11.04 1.00L10.99 2.50A2.60 2.60 0 1 0 13.50 5.01Z'
    const NAV_LABELS = [zh.nav, en.nav]

    /** Repaint our settings nav row's glyph; no-op once it is already ours. */
    function paintNavIcon() {
      const cells = document.querySelectorAll('[role="dialog"] nav button')
      for (const cell of cells) {
        if (NAV_LABELS.indexOf((cell.textContent || '').trim()) === -1) continue
        const svg = cell.querySelector('svg')
        if (svg === null || svg.dataset.tdNavicon === '1') continue
        const path = svg.querySelector('path')
        if (path === null) continue
        path.setAttribute('d', WRENCH_PATH)
        path.setAttribute('fill-rule', 'evenodd')
        path.setAttribute('clip-rule', 'evenodd')
        // The gear is two paths (ring + inner dot); ours is one, so the
        // leftover dot has to go or it draws through the new glyph.
        const extra = svg.querySelectorAll('path')
        for (let i = 1; i < extra.length; i += 1) extra[i].remove()
        svg.dataset.tdNavicon = '1'
      }
    }

    /**
     * Keep repainting across panel mounts; coalesced to one pass per frame.
     *
     * Returns its own disposer. The observer watches the whole document for
     * the life of the page, so it has to come down with the plugin: a client
     * reload re-runs `apply`, and an observer left behind goes on waking on
     * every DOM mutation in the app with nothing to repaint.
     */
    function watchNavIcon() {
      if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {}
      let queued = false
      let live = true
      const run = () => {
        queued = false
        if (!live) return
        try { paintNavIcon() } catch (error) { /* shell internals moved */ }
      }
      const schedule = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (fn) => setTimeout(fn, 16)
      const observer = new MutationObserver(() => {
        if (queued) return
        queued = true
        schedule(run)
      })
      observer.observe(document.body, { childList: true, subtree: true })
      run()
      return () => { live = false; observer.disconnect() }
    }

    // ------------------------------------------------------------------ apply
    const inject = ['slots', 'locale']

    function apply(ctx) {
      // `register` throws when the namespace already carries this locale, which
      // is what a client reload does. It must not share a `try` with the slot
      // registration below: that would turn a re-register into a missing
      // Settings page. `ctx.effect` also unregisters it when the plugin unloads.
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tool-disclosure: locale')
      } catch (error) {
        console.warn('[dsh-tool-disclosure] locale unavailable; falling back to keys:', error)
      }
      try {
        // `settings.section` is the only slot that produces a top-level
        // Settings nav entry.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-tool-disclosure',
              order: 210,
              label: () => ctx.locale.bind(NS)('nav'),
              locale: NS,
            },
            ToolDisclosureSection,
          ),
        )
      } catch (error) {
        console.warn('[dsh-tool-disclosure] settings section failed to mount:', error)
      }
      try {
        ctx.effect(() => watchNavIcon(), 'dsh-tool-disclosure: nav icon')
      } catch (error) {
        console.warn('[dsh-tool-disclosure] nav icon swap unavailable:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
