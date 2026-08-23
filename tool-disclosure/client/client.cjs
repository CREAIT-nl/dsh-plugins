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
    const CSS =
      '.td-card{list-style:none;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border-radius:12px}' +
      '.td-head{align-items:center;gap:12px;padding:14px 16px;display:flex}' +
      '.td-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}' +
      '.td-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
      '.td-desc{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:13px;line-height:1.5}' +
      '.td-body{border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));margin:0 16px;padding:12px 0 8px}' +
      '.td-muted{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:0 0 10px;font-size:12px;line-height:1.5}' +
      '.td-sub{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;line-height:1.5;margin:14px 0 8px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}' +
      '.td-sub:first-child{margin-top:0;padding-top:0;border-top:0}' +
      '.td-row{display:flex;align-items:flex-start;gap:12px;padding:9px 0;border-bottom:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1))}' +
      '.td-row:last-child{border-bottom:0}' +
      '.td-rowtext{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}' +
      '.td-id{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:1.5}' +
      '.td-summary{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}' +
      '.td-names{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.55;word-break:break-all;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}' +
      '.td-cost{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:1.5}' +
      '.td-cost b{font-weight:600;font-variant-numeric:tabular-nums}' +
      // Traced from the shell's own switch rather than approximated: same 36x20
      // track, same 14px thumb, same 16px travel, same tokens throughout. The
      // ON state is where an approximation shows — a white thumb and a
      // border-less track read as a different control sitting one page away
      // from the real ones, and on the olive theme the white also fights the
      // fill it sits on. bg-layer-3 is what the shipped switch puts there.
      '.td-switch{appearance:none;flex:none;cursor:pointer;box-sizing:border-box;width:36px;height:20px;margin-top:2px;padding:0;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));background:var(--dsw-alias-bg-layer-1);position:relative;transition:background .16s,border-color .16s}' +
      '.td-switch:hover:not(:disabled){border-color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}' +
      '.td-switch:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:2px}' +
      '.td-switch:disabled{cursor:default;opacity:.55}' +
      '.td-switch[aria-checked="true"]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary))}' +
      '.td-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);transition:transform .16s,background .16s}' +
      '.td-switch[aria-checked="true"] .td-knob{transform:translateX(16px);background:var(--dsw-alias-bg-layer-3,#fff)}' +
      '.td-stats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 8px}' +
      '.td-stat{flex:1 1 120px;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1)}' +
      '.td-stat-label{display:block;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:1.5}' +
      '.td-stat-value{display:block;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600;line-height:1.4;font-variant-numeric:tabular-nums}' +
      '.td-stat-note{display:block;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:1.5}' +
      '.td-saved .td-stat-value{color:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary))}'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-tool-disclosure/card.css"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-tool-disclosure/card.css'
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
          h('span', { className: 'td-id' }, group.id),
          // Clamped, with the whole thing on hover: the summary is written
          // for the model, and at full length it pushes the switch it
          // belongs to off the first screenful. Same for the names of a
          // 24-tool server.
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

    function Stat(props) {
      return h('div', { className: props.accent ? 'td-stat td-saved' : 'td-stat' },
        h('span', { className: 'td-stat-label' }, props.label),
        h('span', { className: 'td-stat-value' }, props.value),
        props.note ? h('span', { className: 'td-stat-note' }, props.note) : null)
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

      return h('li', { className: 'td-card' },
        h('div', { className: 'td-head' },
          h('span', { className: 'td-headtext' },
            h('span', { className: 'td-name' }, t('title')),
            h('span', { className: 'td-desc' }, t('description')))),
        h('div', { className: 'td-body' },
          h('p', { className: 'td-muted' }, t('hint')),
          !writable ? h('p', { className: 'td-muted' }, t('readOnly')) : null,
          // Shown beside the numbers as well as instead of them: a read that
          // failed after one succeeded leaves what is on screen stale, and a
          // measurement is only worth reading if the page says when it stopped
          // being one.
          unreachable ? h('p', { className: 'td-muted' }, t('unreachable')) : null,
          data === null
            ? (unreachable ? null : h('p', { className: 'td-muted' }, t('loading')))
            : h(React.Fragment, null,
                h('p', { className: 'td-sub' }, t('savingHeading')),
                h('div', { className: 'td-stats' },
                  // No "still advertised" figure: the measurement reads the
                  // shared registry, and a session mounts mode tools of its
                  // own on top of it, so that number would be a guess wearing
                  // a decimal point. What is held back is exact.
                  h(Stat, { label: t('savedLabel'), value: t('approx') + short(held.tokens), note: t('savedNote'), accent: true }),
                  h(Stat, {
                    label: t('deferredToolsLabel'),
                    value: String(held.tools),
                    note: t('ofRegistered').replace('%n', String(total.tools)),
                  })),
                held.tokens === 0 ? h('p', { className: 'td-muted' }, t('savingNone')) : null,
                // One list, costliest first. Every tool the harness holds is
                // in a group whether or not anyone wrote one down, so a page
                // that split the hand-written half from the rest would be
                // showing where the config came from — which is not what
                // anyone is here to decide.
                h('p', { className: 'td-sub' }, t('groupsHeading')),
                h('p', { className: 'td-muted' }, t('groupsHint')),
                groups.length === 0
                  ? h('p', { className: 'td-muted' }, t('empty'))
                  : groups.map((group) => h(GroupRow, {
                      key: group.id, t: t, group: group, writable: writable, onToggle: toggle,
                    })),
                h('p', { className: 'td-muted', style: { marginTop: '10px' } }, t('measured')))))
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
