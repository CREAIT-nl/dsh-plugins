/**
 * @creait/dsh-think-level — browser half.
 *
 * Two surfaces, one setting:
 *
 *  1. A "Thinking Level" Settings page: the `provider + model -> effort` table
 *     the host applies to every session and every subagent that lands on a row.
 *  2. A pill in the composer's tool row: the effort for THIS session, left of
 *     research mode's width control so a depth control can sit to its right.
 *
 * The pill writes through the session's own `modelDirectories` selection — the
 * same channel the model picker uses — so the `/model` popup's effort pane
 * shows the same value instead of disagreeing with it. There is deliberately no
 * second, plugin-owned notion of "the session's effort" to drift out of sync.
 *
 * One subtlety the pill exists to paper over: both shipped model pickers write
 * the model's ADAPTER default effort into the selection whenever the model
 * changes. That is an explicit choice as far as the host can tell, so it would
 * shadow the table forever. So on a model change (and only on a model change —
 * never when the effort itself is edited) the pill re-applies the configured
 * default over it. An effort you pick yourself is never overwritten.
 *
 * Plain JavaScript on purpose: the loader serves this at
 * /plugins/@creait/dsh-think-level/client.js and calls
 * window.__ModuleLoader__.load({ id, factory }).
 */

window.__ModuleLoader__.load({
  id: '@creait/dsh-think-level',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-think-level'
    const CONFIG_ROUTE = '/api/dsh-think-level/config'
    const CATALOG_ROUTE = '/api/dsh-think-level/catalog'
    const EFFORTS_ROUTE = '/api/dsh-think-level/efforts'
    const LEVELS_ROUTE = '/api/dsh-think-level/levels'
    // The Settings page and the pill are two mounts of one table with no
    // service between them. Without this, editing a row for the model you are
    // sitting on leaves the pill reading `auto` + the PROVIDER default while
    // the host has already started applying the new one — a label that lies.
    const TABLE_CHANGED = 'dsh-think-level:changed'

    /** Table key; NUL because no provider or model id may contain it. */
    const KEY = (provider, model) => provider + '\u0000' + model

    /** Resolve an optional cordis service from the client root context. */
    let clientCtx = null
    function ctxGet(name) {
      return clientCtx ? clientCtx.get(name) : undefined
    }

    // ---------------------------------------------------------------- locale
    const zh = {
      nav: '思考档位',
      title: 'Thinking Level',
      description: '按 provider/model 设定默认思考档位。会话内的选择优先，其次是这张表，最后才是供应商自带的默认值。子代理没有会话选择，因此直接采用本表。',
      hint: '未列出的模型不受影响，保持供应商默认。想恢复供应商默认，删除该行即可。',
      readOnly: '本部署的设置为只读。',
      add: '添加',
      remove: '移除',
      providerLabel: 'Provider',
      modelLabel: 'Model',
      effortLabel: '档位',
      noRows: '尚未设定任何默认档位——所有模型均使用供应商默认值。',
      noReasoning: '该模型不支持思考档位。',
      pillTitle: '思考档位',
      pillHint: '本会话的思考档位。“自动”表示不固定：先用设置里的每模型默认值，没有则用供应商默认值。',
      auto: '自动',
      noLevels: '不可调',
      noLevelsHint: '当前模型没有公布任何思考档位。它的能力由所属适配器自行声明，这里无法更改。',
      enable: '启用思考档位',
      enableNote: 'Off · Low · Medium · High · Max',
      enableHint: '为该模型在 llm-pi-ai 中声明标准档位，立即生效，其他配置不变。若该部署并不真正支持，档位会被忽略——随时可以移除。',
      removeLevels: '移除档位声明',
      declaredHere: '该模型的思考档位由本插件声明。',
    }
    const en = {
      nav: 'Thinking Level',
      title: 'Thinking Level',
      description: 'Set the default thinking level per provider/model. A session’s own choice wins, then this table, then the provider’s own default. Subagents have no session choice, so they take this table.',
      hint: 'A model with no row here is untouched and keeps the provider default. Removing a row is how you go back to it.',
      readOnly: 'This deployment stores settings read-only.',
      add: 'Add',
      remove: 'Remove',
      providerLabel: 'Provider',
      modelLabel: 'Model',
      effortLabel: 'Level',
      noRows: 'No defaults set — every model uses its provider default.',
      noReasoning: 'This model has no thinking levels.',
      pillTitle: 'Thinking level',
      pillHint: 'Thinking level for this session. "Auto" pins nothing: the per-model default from Settings applies, and the provider default behind it.',
      auto: 'Auto',
      noLevels: 'not adjustable',
      noLevelsHint: 'This model publishes no thinking levels. Its adapter declares its own capabilities, and this plugin cannot change them.',
      enable: 'Enable thinking levels',
      enableNote: 'Off · Low · Medium · High · Max',
      enableHint: 'Declare the standard levels for this model in llm-pi-ai. It applies immediately and changes nothing else. If the deployment ignores them the levels are simply no-ops — remove them again whenever.',
      removeLevels: 'Remove levels',
      declaredHere: 'This model’s thinking levels are declared by this plugin.',
    }

    // ------------------------------------------------------------ transport
    // Failures resolve to null so callers stay simple, but they do NOT fail
    // silently. The routes answer 403 (not loopback), 400 (bad payload) and 409
    // (revision conflict), and collapsing those into the same quiet null as an
    // offline server makes a rejected write indistinguishable from an applied
    // one — the setting simply would not stick, with nothing anywhere to say
    // why. The console line is the only place the pill can carry that.
    function warn(method, url, detail) {
      try { console.warn('[dsh-think-level] ' + method + ' ' + url + ' failed: ' + detail) } catch (ignored) { /* no console */ }
    }

    function requestJson(method, url, body) {
      return fetch(url, {
        method: method,
        headers: body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then((response) => {
          if (response.ok) return response.json()
          return response.json().then(
            (payload) => { warn(method, url, response.status + ' ' + (payload && payload.error ? payload.error : '')); return null },
            () => { warn(method, url, String(response.status)); return null },
          )
        })
        .catch((error) => { warn(method, url, String(error)); return null })
    }

    /** The table as `{ [provider\0model]: effort }`, from a config view. */
    function tableOf(view) {
      const rows = view && view.value && Array.isArray(view.value.defaults) ? view.value.defaults : []
      const map = {}
      for (const row of rows) {
        if (!row || !row.provider || !row.model || !row.effort) continue
        map[KEY(row.provider, row.model)] = row.effort
      }
      return map
    }

    // ------------------------------------------------------------- styles
    const CSS =
      '.tl-card{list-style:none;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border-radius:12px}' +
      '.tl-card-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;background:0 0;border:0;align-items:center;gap:12px;padding:14px 16px;display:flex}' +
      '.tl-card-head{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}' +
      '.tl-card-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}' +
      '.tl-card-desc{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:13px;line-height:1.5}' +
      '.tl-card-body{border-top:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));margin:0 16px;padding:12px 0 8px}' +
      '.tl-row{display:flex;align-items:center;gap:8px;margin:0 0 8px;flex-wrap:wrap}' +
      '.tl-row-label{flex:1 1 220px;min-width:160px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5}' +
      '.tl-input{box-sizing:border-box;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));border-radius:6px;padding:5px 8px;font-size:13px;line-height:1.5;min-width:130px}' +
      '.tl-input:disabled{opacity:.55}' +
      '.tl-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));border-radius:6px;padding:4px 10px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:transparent}' +
      '.tl-btn:disabled{cursor:default;opacity:.55}' +
      '.tl-btn-primary{color:#fff;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent}' +
      '.tl-muted{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));margin:0 0 8px;font-size:12px;line-height:1.5}' +
      // The composer control copies the harness's own menu trigger — same
      // height, radius, weight and hover as the access-mode selector sitting
      // next to it — because a control in that row that styles itself reads as
      // a foreign object. The tokens are the harness's; the measurements are
      // taken from `Sh0Q9G_trigger` and the shared menu component.
      '.tl-root{position:relative;display:inline-flex}' +
      '.tl-pill{display:inline-flex;box-sizing:border-box;align-items:center;gap:4px;min-width:0;max-width:220px;height:28px;' +
      'padding:0 4px 0 8px;border:0;border-radius:24px;background:0 0;outline:none;cursor:pointer;font:inherit;' +
      'color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:500;line-height:20px}' +
      '.tl-pill:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.tl-pill:focus-visible{box-shadow:0 0 0 2px var(--dsw-alias-border-l3)}' +
      '.tl-pill:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}' +
      '.tl-pill[data-pinned="1"]{color:var(--dsw-alias-label-primary)}' +
      '.tl-icon{flex:0 0 auto;display:inline-flex}' +
      '.tl-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.tl-chevron{color:var(--dsw-alias-label-caption);flex:0 0 auto;display:inline-flex;transition:transform .12s}' +
      '.tl-chevron[data-open="1"]{transform:rotate(180deg)}' +
      // Opens upward and anchors to its RIGHT edge: this row lives at the
      // bottom of the window (which is why the harness's own menus here carry
      // its `sideTop` variant), and the pill sits at the trailing end of it,
      // where a left-anchored popup would grow towards the send button.
      '.tl-menu{position:absolute;bottom:calc(100% + 4px);right:0;z-index:100;min-width:164px;max-width:360px;box-sizing:border-box;' +
      'padding:4px;display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;' +
      'background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3)}' +
      '.tl-item{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:5px 10px;border:none;border-radius:10px;' +
      'background:transparent;cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);text-align:left}' +
      '.tl-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.tl-item-label{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.tl-item-note{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px}' +
      '.tl-check{flex:0 0 auto;color:var(--dsw-alias-label-primary)}' +
      // The one action row carries a subtitle rather than a trailing note: the
      // level list is longer than the label, and side by side inside a menu
      // this narrow the label is what gets ellipsised away.
      '.tl-item-stack{flex-direction:column;align-items:flex-start;gap:1px;padding:7px 10px}' +
      '.tl-item-stack .tl-item-label{flex:0 0 auto;overflow:visible;white-space:nowrap}' +
      '.tl-item-stack .tl-item-note{line-height:16px;white-space:nowrap}'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-think-level/level.css"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-think-level/level.css'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /**
     * A brain — thinking, which is what this sets the level of.
     *
     * Rising bars said "signal strength" more than they said "how hard it
     * thinks". Drawn as one bumpy half mirrored about the centre line, so the
     * two hemispheres are exactly symmetric and the whole glyph is two paths:
     * at 14px the bumps flatten and what survives is a round head split down
     * the middle, which is the read that matters in the pill.
     */
    const BRAIN_HALF = 'M8 2.5c-.6-.9-2.2-1-3 .1-1.4-.3-2.7.9-2.5 2.3-1.2.6-1.4 2.4-.3 3.2'
      + '-.6 1.1-.1 2.6 1.1 3 .1 1.3 1.4 2.2 2.6 1.9.4.8 1.5 1.1 2.1.6'

    function LevelIcon() {
      return h('svg', {
        className: 'tl-icon', width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      },
        h('path', { key: 'left', d: BRAIN_HALF }),
        h('g', { key: 'right', transform: 'translate(16 0) scale(-1 1)' }, h('path', { d: BRAIN_HALF })),
        h('path', { key: 'sulcus', d: 'M8 2.5v11.1' }),
      )
    }

    /** The harness's own chevron and check, so the menu reads as one of its own. */
    function Chevron(props) {
      return h('span', { className: 'tl-chevron', 'data-open': props.open ? '1' : '0' },
        h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
          h('path', {
            d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912'
              + ' 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756'
              + ' 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137'
              + ' 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291'
              + ' 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813'
              + ' 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11'
              + ' 4.65137L11.8486 5.5Z',
            fill: 'currentColor',
          }),
        ),
      )
    }

    function CheckIcon() {
      return h('svg', {
        className: 'tl-check', width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        'aria-hidden': 'true', focusable: 'false',
      },
        h('path', {
          d: 'M15.0498 3.92579L8.49512 12.3818C8.25774 12.6881 8.04517 12.9645 7.84668 13.1689C7.63957 13.3823 7.38732'
            + ' 13.5841 7.04492 13.6719C6.86373 13.7183 6.6757 13.7346 6.48926 13.7197C6.13666 13.6915 5.8528 13.5355'
            + ' 5.6123 13.3604C5.38201 13.1926 5.12573 12.9567 4.83984 12.6953L1.03125 9.21289L1.96875 8.1875L5.77734'
            + ' 11.6699C6.08684 11.9529 6.27773 12.1249 6.43066 12.2363C6.50183 12.2882 6.54699 12.3135 6.57324'
            + ' 12.3252C6.58525 12.3305 6.59269 12.3322 6.5957 12.333C6.59802 12.3336 6.59961 12.334 6.59961'
            + ' 12.334C6.63317 12.3367 6.66758 12.3335 6.7002 12.3252C6.7002 12.3252 6.70211 12.3251 6.7041'
            + ' 12.3242C6.70698 12.3229 6.71348 12.319 6.72461 12.3115C6.74849 12.2956 6.78843 12.2642 6.84961'
            + ' 12.2012C6.98138 12.0654 7.13957 11.8628 7.39648 11.5313L13.9502 3.07422L15.0498 3.92579Z',
          fill: 'currentColor',
        }),
      )
    }

    // ------------------------------------------------------- settings page
    function Select(props) {
      return h('select', {
        className: 'tl-input',
        value: props.value,
        disabled: props.disabled,
        onChange: (event) => props.onChange(event.target.value),
      },
        h('option', { key: '', value: '', disabled: true }, props.placeholder),
        props.options.map((option) => h('option', { key: option.id, value: option.id }, option.name)),
      )
    }

    function ThinkLevelCard(props) {
      const t = props.t || ((key) => key)
      const [view, setView] = React.useState({ status: 'unavailable', value: { defaults: [] }, writable: false })
      const [catalog, setCatalog] = React.useState({ providers: [], models: {} })
      const [efforts, setEfforts] = React.useState({})
      const [selProvider, setSelProvider] = React.useState('')
      const [selModel, setSelModel] = React.useState('')
      const [selEffort, setSelEffort] = React.useState('')
      // What `llm-pi-ai` declares for the pair being composed, and whether it
      // can be changed from here. One pair, so one request — this is the row
      // that has controls on it.
      const [declaration, setDeclaration] = React.useState(null)
      const asked = React.useRef({})

      React.useEffect(() => {
        requestJson('GET', CONFIG_ROUTE).then((next) => { if (next !== null) setView(next) })
        requestJson('GET', CATALOG_ROUTE).then((next) => {
          if (next === null) return
          setCatalog(next)
          setSelProvider((cur) => (cur && next.providers.some((p) => p.id === cur)
            ? cur
            : (next.providers.length ? next.providers[0].id : '')))
        })
      }, [])

      React.useEffect(() => { setSelModel(''); setSelEffort('') }, [selProvider])

      const rows = view.value && Array.isArray(view.value.defaults) ? view.value.defaults : []
      const writable = view.writable === true
      const models = selProvider && catalog.models[selProvider] ? catalog.models[selProvider] : []

      // Every route whose level list this card needs to render right now: one
      // per configured row, plus the pair being composed in the add line.
      const wanted = rows.map((row) => KEY(row.provider, row.model))
      if (selProvider && selModel) wanted.push(KEY(selProvider, selModel))
      const wantedKey = wanted.join('\n')

      // Asked-once in a ref rather than gated on `efforts`: gating on the state
      // this effect sets is how a fetch loop starts.
      React.useEffect(() => {
        let active = true
        for (const key of wantedKey === '' ? [] : wantedKey.split('\n')) {
          if (asked.current[key] === true) continue
          asked.current[key] = true
          const sep = key.indexOf('\u0000')
          const query = '?provider=' + encodeURIComponent(key.slice(0, sep)) + '&model=' + encodeURIComponent(key.slice(sep + 1))
          requestJson('GET', EFFORTS_ROUTE + query).then((answer) => {
            if (!active) return
            const list = answer && Array.isArray(answer.efforts) ? answer.efforts : []
            setEfforts((prev) => Object.assign({}, prev, { [key]: list }))
          })
        }
        return () => { active = false }
      }, [wantedKey])

      const save = (next) => {
        requestJson('POST', CONFIG_ROUTE, { defaults: next }).then((answer) => {
          if (answer === null) return
          setView(answer)
          try { window.dispatchEvent(new CustomEvent(TABLE_CHANGED)) } catch (ignored) { /* no CustomEvent */ }
        })
      }
      const addRow = () => {
        if (!selProvider || !selModel || !selEffort) return
        save(rows
          .filter((row) => !(row.provider === selProvider && row.model === selModel))
          .concat([{ provider: selProvider, model: selModel, effort: selEffort }]))
        setSelModel('')
        setSelEffort('')
      }
      const removeRow = (provider, model) => save(rows.filter((row) => !(row.provider === provider && row.model === model)))
      const updateRow = (provider, model, effort) => save(rows.map((row) => (
        row.provider === provider && row.model === model ? { provider: provider, model: model, effort: effort } : row
      )))

      React.useEffect(() => {
        if (!selProvider || !selModel) { setDeclaration(null); return undefined }
        let active = true
        const query = '?provider=' + encodeURIComponent(selProvider) + '&model=' + encodeURIComponent(selModel)
        requestJson('GET', LEVELS_ROUTE + query).then((answer) => { if (active) setDeclaration(answer) })
        return () => { active = false }
      }, [selProvider, selModel])

      // Declaring writes pi-ai's namespace, not this plugin's — see
      // lib/pi-ai-levels.js. Withdrawing one takes the table row with it: a row
      // naming a level the model no longer publishes is dropped by the host
      // anyway, and leaving it on screen would promise something no request
      // keeps.
      const declare = (next) => {
        if (!selProvider || !selModel) return
        const key = KEY(selProvider, selModel)
        const query = '?provider=' + encodeURIComponent(selProvider) + '&model=' + encodeURIComponent(selModel)
        requestJson('POST', LEVELS_ROUTE + query, { efforts: next }).then((answer) => {
          if (answer === null) return
          setDeclaration(answer)
          setEfforts((prev) => Object.assign({}, prev, { [key]: answer.supported || [] }))
          setSelEffort('')
          if (next === null) save(rows.filter((row) => !(row.provider === selProvider && row.model === selModel)))
        })
      }

      const addLevels = selProvider && selModel ? (efforts[KEY(selProvider, selModel)] || []) : []

      // Three states, one row: nothing to offer and nothing to be done about
      // it; nothing to offer YET; and levels this plugin put there, which it
      // can therefore take away again.
      let declareRow = null
      if (selProvider && selModel && declaration !== null) {
        const supported = Array.isArray(declaration.supported) ? declaration.supported : []
        const mine = declaration.declared !== null && declaration.declared !== undefined && declaration.declared !== false
        if (supported.length === 0) {
          declareRow = h('div', { className: 'tl-row' },
            h('span', { className: 'tl-row-label' }, t('noReasoning')),
            declaration.writable === true
              ? h('button', { className: 'tl-btn', title: t('enableHint'), onClick: () => declare(declaration.suggested) }, t('enable'))
              : null)
        } else if (mine && declaration.writable === true) {
          declareRow = h('div', { className: 'tl-row' },
            h('span', { className: 'tl-row-label' }, t('declaredHere')),
            h('button', { className: 'tl-btn', onClick: () => declare(null) }, t('removeLevels')))
        }
      }

      return h('li', { className: 'tl-card' },
        h('div', { className: 'tl-card-header' },
          h('span', { className: 'tl-card-head' },
            h('span', { className: 'tl-card-name' }, t('title')),
            h('span', { className: 'tl-card-desc' }, t('description')))),
        h('div', { className: 'tl-card-body' },
          h('p', { className: 'tl-muted' }, t('hint')),
          !writable ? h('p', { className: 'tl-muted' }, t('readOnly')) : null,
          rows.length === 0 ? h('p', { className: 'tl-muted' }, t('noRows')) : null,
          rows.map((row) => {
            const key = KEY(row.provider, row.model)
            const levels = efforts[key]
            return h('div', { key: key, className: 'tl-row' },
              h('span', { className: 'tl-row-label' }, row.provider + ' / ' + row.model),
              // While the level list is still loading, the row still has to
              // show the effort it stores — an empty select would read as "no
              // level set" for a row that very much sets one.
              h('select', {
                className: 'tl-input',
                value: row.effort,
                disabled: !writable,
                onChange: (event) => updateRow(row.provider, row.model, event.target.value),
              }, (levels === undefined || levels.length === 0
                ? [{ id: row.effort, name: row.effort }]
                : levels).map((level) => h('option', { key: level.id, value: level.id }, level.name))),
              h('button', {
                className: 'tl-btn',
                disabled: !writable,
                onClick: () => removeRow(row.provider, row.model),
              }, t('remove')))
          }),
          h('div', { className: 'tl-row' },
            h(Select, {
              value: selProvider, options: catalog.providers, disabled: !writable,
              placeholder: t('providerLabel'), onChange: setSelProvider,
            }),
            h(Select, {
              value: selModel, options: models, disabled: !writable,
              placeholder: t('modelLabel'), onChange: setSelModel,
            }),
            h(Select, {
              value: selEffort, options: addLevels, disabled: !writable || addLevels.length === 0,
              placeholder: t('effortLabel'), onChange: setSelEffort,
            }),
            h('button', {
              className: 'tl-btn tl-btn-primary',
              disabled: !writable || !selProvider || !selModel || !selEffort,
              onClick: addRow,
            }, t('add'))),
          declareRow,
        ),
      )
    }

    /** The `settings.section` page. */
    function ThinkLevelSection(props) {
      return h('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } }, h(ThinkLevelCard, props))
    }

    // -------------------------------------------------------- composer pill
    /** Never-changing empty selector, so the hook call stays unconditional. */
    const NO_SESSION = () => undefined

    /**
     * The session's thinking level.
     * @param props - composed slot props: `sessionId`, the `useSession`
     *   standard hook, and the bound `t`.
     * @returns the pill, or null when this model has no levels to pick from.
     */
    function ThinkPill(props) {
      const t = props.t || ((key) => key)
      const sessionId = props.sessionId
      const useSession = props.useSession || NO_SESSION
      const subagent = useSession((state) => (state ? state.subagent : null))
      const removed = useSession((state) => (state ? state.removed : false))

      const [dir, setDir] = React.useState(null)
      // null means "not read yet" and is NOT the same as {}: the reconcile
      // below must not conclude "no default configured" from a config request
      // that has not come back.
      const [table, setTable] = React.useState(null)
      const [tableTick, setTableTick] = React.useState(0)
      // What `llm-pi-ai` says about this model's levels, and whether this
      // plugin may change it. Only ever fetched for a model that publishes
      // none — for every other model it is an answer nobody would read.
      const [declared, setDeclared] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const lastRoute = React.useRef(null)
      const rootRef = React.useRef(null)

      React.useEffect(() => {
        const models = ctxGet('modelDirectories')
        if (models === undefined) return undefined
        let directory = null
        try { directory = models.directoryFor(sessionId) } catch (error) { return undefined }
        setDir(directory)
        // A subagent's session is driven by its parent; asking it to load its
        // own directory is the one call that reliably errors here.
        if (subagent === null) directory.load().catch(() => {})
        return undefined
      }, [sessionId, subagent])

      const store = dir === null ? null : dir.store
      const state = React.useSyncExternalStore(
        (fn) => (store === null ? () => {} : store.subscribe(fn)),
        () => (store === null ? null : store.getSnapshot()),
      )

      const current = state === null ? null : state.current
      const groups = state === null ? [] : state.groups
      const route = current === null ? '' : KEY(current.provider, current.model)

      let reasoning
      if (current !== null) {
        for (const group of groups) {
          if (group.id !== current.provider) continue
          for (const model of group.models) if (model.id === current.model) reasoning = model.reasoning
        }
      }

      // A model with nothing to publish is the interesting case, not the dead
      // end it used to be: pi-ai reads its capability metadata out of a
      // SETTINGS namespace, so the levels can be declared from here. Ask
      // whether they can be, for this route.
      const missing = current !== null && (reasoning === undefined || reasoning.efforts.length === 0)
      React.useEffect(() => {
        if (!missing || current === null) { setDeclared(null); return undefined }
        let active = true
        const query = '?provider=' + encodeURIComponent(current.provider) + '&model=' + encodeURIComponent(current.model)
        requestJson('GET', LEVELS_ROUTE + query).then((answer) => { if (active) setDeclared(answer) })
        return () => { active = false }
      }, [missing, route])

      React.useEffect(() => {
        const onChanged = () => setTableTick((tick) => tick + 1)
        window.addEventListener(TABLE_CHANGED, onChanged)
        return () => window.removeEventListener(TABLE_CHANGED, onChanged)
      }, [])

      // Re-read on every model change — the moment the table's answer is about
      // to matter — and whenever the Settings page says it changed.
      React.useEffect(() => {
        if (route === '') return undefined
        let active = true
        requestJson('GET', CONFIG_ROUTE).then((view) => { if (active) setTable(tableOf(view)) })
        return () => { active = false }
      }, [route, tableTick])

      let configured
      if (table !== null && reasoning !== undefined) {
        const stored = table[route]
        // A level the model does not publish would be refused by the host too;
        // showing it here would promise something the request cannot keep.
        if (stored !== undefined && reasoning.efforts.some((level) => level.id === stored)) configured = stored
      }

      // Re-apply the configured default over the adapter default that the model
      // pickers write on a model change — and ONLY on a model change, so an
      // effort picked by hand is never overwritten. `lastRoute` advances only
      // once there is enough loaded to decide, otherwise the first render (no
      // groups, no table) would consume the change and skip the write.
      React.useEffect(() => {
        if (dir === null || current === null || table === null || reasoning === undefined) return
        if (subagent !== null || removed) return
        const previous = lastRoute.current
        lastRoute.current = route
        if (previous === route || configured === undefined) return
        if (current.reasoningEffort === configured) return
        // First sight of a session never clobbers a level someone already set.
        if (previous === null && current.reasoningEffort !== undefined) return
        dir.select({ provider: current.provider, model: current.model, reasoningEffort: configured })
          .catch((error) => warn('select', route, String(error)))
      }, [dir, current, table, reasoning, configured, route, subagent, removed])

      // `auto` is a verb here, not a state. The host resolves every model
      // switch through the adapter and materializes its default effort, so the
      // session field cannot be left empty — which means picking `auto` and
      // sending nothing would hand back the ADAPTER default, ignoring the very
      // table row the option's own label just promised. Send the table's answer
      // explicitly; fall through to the adapter only where the table is silent,
      // which is what `auto` means for a model with no row.
      const choose = React.useCallback((picked) => {
        setOpen(false)
        if (dir === null || current === null) return
        const chosen = picked === null ? configured : picked
        const selection = { provider: current.provider, model: current.model }
        if (chosen !== undefined) selection.reasoningEffort = chosen
        dir.select(selection).catch((error) => warn('select', route, String(error)))
      }, [dir, current, configured, route])

      // Declaring the levels is a write to pi-ai's namespace, not to this
      // plugin's table — see lib/pi-ai-levels.js. Nothing else needs doing
      // afterwards: the model directory reloads on `settings/document-updated`
      // on its own, so the pill this was clicked on becomes a live one.
      const declare = React.useCallback((efforts) => {
        setOpen(false)
        if (current === null) return
        const query = '?provider=' + encodeURIComponent(current.provider) + '&model=' + encodeURIComponent(current.model)
        requestJson('POST', LEVELS_ROUTE + query, { efforts: efforts })
          .then((answer) => { if (answer !== null) setDeclared(answer) })
      }, [current])

      // The harness's menus close on an outside press and on Escape, and a
      // control that copies their look has to copy that too — capture phase,
      // because the composer stops some of these on the way up.
      React.useEffect(() => {
        if (!open || typeof document === 'undefined' || !document.addEventListener) return undefined
        const onDown = (event) => {
          const node = rootRef.current
          if (node && node.contains && node.contains(event.target)) return
          setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      if (current === null) return null

      // A model that publishes no levels used to render nothing at all, which
      // looked like the plugin had failed rather than like the model having
      // nothing to offer — and a control that comes and goes with the model is
      // worse than one that stays put and says why. Where the levels CAN be
      // declared it says so and offers to; where they cannot — another adapter
      // owns the model's capabilities — it stays disabled with the reason.
      if (missing) {
        const canDeclare = declared !== null && declared.writable === true && subagent === null && !removed
        return h('span', { className: 'tl-root', ref: rootRef },
          h('button', {
            key: 'trigger',
            type: 'button',
            className: 'tl-pill',
            disabled: !canDeclare,
            title: t('pillTitle') + ' — ' + (canDeclare ? t('enableHint') : t('noLevelsHint')),
            'aria-label': t('pillTitle'),
            'aria-haspopup': canDeclare ? 'menu' : undefined,
            'aria-expanded': canDeclare ? (open ? 'true' : 'false') : undefined,
            onClick: () => setOpen((was) => !was),
          },
            h(LevelIcon, { key: 'icon' }),
            h('span', { key: 'text', className: 'tl-text' }, t('noLevels')),
            canDeclare ? h(Chevron, { key: 'chevron', open: open }) : null,
          ),
          open && canDeclare ? h('div', { key: 'menu', className: 'tl-menu', role: 'menu' },
            h('button', {
              type: 'button',
              role: 'menuitem',
              className: 'tl-item tl-item-stack',
              onClick: () => declare(declared.suggested),
            },
              h('span', { key: 'label', className: 'tl-item-label' }, t('enable')),
              h('span', { key: 'note', className: 'tl-item-note' }, t('enableNote')),
            ),
          ) : null,
        )
      }

      const levels = reasoning.efforts
      const pinned = current.reasoningEffort
      const fallback = configured === undefined ? reasoning.defaultEffort : configured
      const nameOf = (id) => {
        for (const level of levels) if (level.id === id) return level.name
        return String(id)
      }
      const disabled = subagent !== null || removed
      const autoLabel = fallback === undefined ? t('auto') : t('auto') + ' · ' + nameOf(fallback)

      return h('span', { className: 'tl-root', ref: rootRef },
        h('button', {
          key: 'trigger',
          type: 'button',
          className: 'tl-pill',
          'data-pinned': pinned === undefined ? '0' : '1',
          disabled: disabled,
          title: t('pillTitle') + ' — ' + t('pillHint'),
          'aria-label': t('pillTitle'),
          'aria-haspopup': 'menu',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((was) => !was),
        },
          h(LevelIcon, { key: 'icon' }),
          h('span', { key: 'text', className: 'tl-text' },
            pinned === undefined ? autoLabel : nameOf(pinned)),
          h(Chevron, { key: 'chevron', open: open }),
        ),
        open && !disabled ? h('div', { key: 'menu', className: 'tl-menu', role: 'menu' },
          h('button', {
            key: 'auto',
            type: 'button',
            role: 'menuitem',
            className: 'tl-item',
            onClick: () => choose(null),
          },
            h('span', { key: 'label', className: 'tl-item-label' }, t('auto')),
            fallback === undefined ? null : h('span', { key: 'note', className: 'tl-item-note' }, nameOf(fallback)),
            pinned === undefined ? h(CheckIcon, { key: 'check' }) : null,
          ),
          levels.map((level) => h('button', {
            key: level.id,
            type: 'button',
            role: 'menuitem',
            className: 'tl-item',
            onClick: () => choose(level.id),
          },
            h('span', { key: 'label', className: 'tl-item-label' }, level.name),
            pinned === level.id ? h(CheckIcon, { key: 'check' }) : null,
          )),
        ) : null,
      )
    }

    // ------------------------------------------------------------------ apply

    const inject = ['slots', 'locale']

    function apply(ctx) {
      clientCtx = ctx
      // Registered through `effect` so a client reload disposes the namespace
      // before re-registering it. Registering bare throws the second time
      // ("already has locale zh"), and sharing a try/catch with the surfaces
      // below would let that throw take them down with it.
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-think-level: locale')
      } catch (error) {
        console.warn('[dsh-think-level] locale unavailable; falling back to keys:', error)
      }
      try {
        // `settings.section` is the only slot that produces a top-level
        // Settings nav entry; `settings.plugin.item` alone buries the table
        // inside the nested plugin-config tab.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-think-level',
              order: 190,
              label: () => ctx.locale.bind(NS)('nav'),
              locale: NS,
            },
            ThinkLevelSection,
          ),
        )
      } catch (error) {
        console.warn('[dsh-think-level] settings page failed to mount:', error)
      }
      try {
        // Scoped-inject rather than a module-level dependency: the Settings
        // page must still mount on a composition without the model-selection
        // service, where only the pill is impossible.
        ctx.inject(['slots', 'locale', 'conversation', 'modelDirectories'], (scope) => {
          // The TRAILING end of the tool row, not the leading one: the bar
          // renders `.right` immediately before the named model seat, and the
          // level belongs to the model, not to the mode. On the left it sat
          // among the access-mode and plan controls — where a mode plugin's own
          // control is also registered — and read as one of them.
          scope.slots.inject('conversation.input.right', () =>
            scope.slots.register(
              {
                name: 'conversation.input.right',
                id: 'think-level',
                order: 10,
                locale: NS,
              },
              ThinkPill,
            ),
          )
        })
      } catch (error) {
        console.warn('[dsh-think-level] composer pill failed to mount:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
