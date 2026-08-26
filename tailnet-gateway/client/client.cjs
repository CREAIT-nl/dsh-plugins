/**
 * dsh-tailnet-gateway — browser half.
 *
 * Registers the "Tailnet Access" page into the Web settings panel as a
 * top-level `settings.section` nav entry. It reads/writes the host-registered
 * `dsh-tailnet-gateway` namespace through the plugin-owned
 * /api/dsh-tailnet-gateway/* routes (see lib/settings-routes.js) and lists the
 * live tailnet peers from the same `tailscale status` the gate consults, so
 * the device you are choosing between is the device the gate will see.
 *
 * Chrome comes from `@deepseek-ai/dsh-client-ui-primitives`, the shell's seed
 * module (available to any bundle exactly like `react`, with no `inject` entry
 * and no dependency), so the controls are the same Button/Input/Menu/Pill the
 * harness's own settings pages draw. There is no Switch primitive, so every
 * on/off here is a two-item Menu, which is how the harness renders a choice.
 *
 * Plain JavaScript on purpose: the loader serves this at
 * /plugins/@creait/dsh-tailnet-gateway/client.js and calls
 * window.__ModuleLoader__.load({ id, factory }).
 */

window.__ModuleLoader__.load({
  id: '@creait/dsh-tailnet-gateway',
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

    const NS = 'dsh-tailnet-gateway'
    const CONFIG_ROUTE = '/api/dsh-tailnet-gateway/config'
    const DEVICES_ROUTE = '/api/dsh-tailnet-gateway/devices'

    /** How long typing settles before the logins field is written. */
    const WRITE_DELAY_MS = 600

    // ---------------------------------------------------------------- locale
    const zh = {
      nav: 'Tailnet 访问',
      title: 'Tailnet Access',
      description: 'dsh 只监听本机回环地址。此网关为 tailnet 设备提供唯一入口：先验证身份，再以回环连接转发给 dsh，因此设置、模型和插件页面在远程也能正常工作。',
      readOnly: '本部署的设置为只读。',
      statusOn: '正在监听', statusOff: '未运行', statusDisabled: '已停用',
      serveHint: '用以下命令发布到 tailnet：',
      enabledLabel: '启用网关',
      enabledNote: '关闭后 tailnet 无法访问 dsh；本机 localhost 不受影响。',
      loginHeading: '身份',
      requireLoginLabel: '要求 Tailscale 登录',
      requireLoginNote: 'tailscale serve 会在每个请求上盖上真实的登录名，客户端无法伪造。带标签的服务器没有人类归属，因此本项已将其排除在外。',
      loginsLabel: '允许的登录账号',
      loginsNote: '留空表示"本机的所有者"。多个账号用逗号分隔。',
      loginsPlaceholder: '本机所有者',
      deviceHeading: '设备',
      deviceListLabel: '仅限指定设备',
      deviceListNote: '开启后，只有下方勾选的设备可以连接——即使它们登录的是同一个账号。',
      devicesUnavailable: '无法读取 tailscale status；设备列表不可用。',
      allowed: '允许', blocked: '禁止', thisNode: '本机', you: '当前设备',
      advancedHeading: '高级',
      trustLabel: '将网关会话视为回环',
      trustNote: 'dsh 的客户端仅凭浏览器地址栏判断是否为本机，因此远程访问时设置页面会退化为临时存储。开启后网关在下发脚本时如实说明这一跳确实是回环连接。关闭它，远程的设置、模型和插件页面将不可用。',
      on: '开启', off: '关闭',
    }
    const en = {
      nav: 'Tailnet Access',
      title: 'Tailnet Access',
      description: 'dsh listens on loopback only. This gateway is the single way in from your tailnet: it identifies the caller first, then forwards over loopback, which is why Settings, Models and Plugins work remotely instead of failing.',
      readOnly: 'This deployment stores settings read-only.',
      statusOn: 'Listening', statusOff: 'Not running', statusDisabled: 'Disabled',
      serveHint: 'Publish it to the tailnet with:',
      enabledLabel: 'Enable the gateway',
      enabledNote: 'Off means no tailnet device can reach dsh. localhost on this machine is unaffected either way.',
      loginHeading: 'Identity',
      requireLoginLabel: 'Require a Tailscale login',
      requireLoginNote: 'tailscale serve stamps the real login on every request and overwrites whatever the client sent, so this cannot be forged. Tagged servers have no human owner and are excluded by it.',
      loginsLabel: 'Allowed logins',
      loginsNote: 'Empty means "whoever owns this node". Separate several with commas.',
      loginsPlaceholder: 'the owner of this node',
      deviceHeading: 'Devices',
      deviceListLabel: 'Restrict to specific devices',
      deviceListNote: 'On, only the devices ticked below may connect — even ones signed in as you. Edit the list first, then turn this on.',
      devicesUnavailable: 'Could not read tailscale status; the device list is unavailable.',
      allowed: 'Allowed', blocked: 'Blocked', thisNode: 'this node', you: 'you',
      advancedHeading: 'Advanced',
      trustLabel: 'Treat gateway sessions as loopback',
      trustNote: 'The dsh client decides "am I local?" from the address bar alone, so remotely the settings pages fall back to a throwaway store. On, the gateway states the truth about the hop as it serves that script. Off, Settings, Models and Plugins stop working remotely.',
      on: 'On', off: 'Off',
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
    // 8px field radii. Every token used here exists in dsh-client-ui-theme.
    const CSS =
      '.tg-section{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}' +
      '.tg-heading{margin:0;font-size:18px;font-weight:600;line-height:26px}' +
      '.tg-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}' +
      '.tg-subheading{margin:12px 0 0;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}' +
      '.tg-readonly{margin:0;padding:8px 12px;border-radius:8px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}' +
      '.tg-status{display:flex;flex-direction:column;gap:6px;padding:12px;border-radius:8px;background:var(--dsw-alias-bg-module-platform)}' +
      '.tg-status-line{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}' +
      '.tg-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}' +
      '.tg-stack{display:flex;flex-direction:column}' +
      '.tg-stack>:last-child{border-bottom:none}' +
      '.tg-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}' +
      '.tg-row-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}' +
      '.tg-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px;overflow-wrap:anywhere}' +
      '.tg-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}' +
      '.tg-pills{display:inline-flex;align-items:center;gap:6px;flex:none}' +
      '.tg-selector{display:inline-flex;align-items:center;gap:12px;height:36px;padding:0 14px;border:none;border-radius:18px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}' +
      '.tg-selector:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}' +
      '.tg-selector:disabled{cursor:default}' +
      '.tg-selector-label{max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.tg-chevron{flex:none}' +
      // The Input primitive's wrap is inline-flex with no width of its own, so
      // the width lives on this holder and is handed down to whatever it wraps.
      '.tg-field{display:inline-flex;flex:none;width:260px}' +
      '.tg-field>*{width:100%}' +
      '.tg-field input{width:100%;min-width:0}' +
      // Used only if the primitives module ever fails to resolve.
      '.tg-input{box-sizing:border-box;height:34px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5}' +
      '.tg-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}' +
      '.tg-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}' +
      '.tg-btn{appearance:none;font:inherit;cursor:pointer;height:36px;padding:0 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:18px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent}' +
      '.tg-btn:disabled{cursor:not-allowed;opacity:.4}' +
      '.tg-btn-primary{color:var(--dsw-alias-label-primary-foreground);background:var(--dsw-alias-button-primary-fill);border-color:transparent}'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-tailnet-gateway/card.css"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.pluginCss = 'dsh-tailnet-gateway/card.css'
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
        className: props.variant === 'primary' ? 'tg-btn tg-btn-primary' : 'tg-btn',
        disabled: props.disabled,
        onClick: props.onClick,
      }, props.children)
    }

    /** Text field. The holder owns the width; the primitive owns the chrome. */
    function Text(props) {
      const attrs = {
        type: 'text',
        value: props.value,
        disabled: props.disabled,
        placeholder: props.placeholder,
        onChange: (e) => props.onChange(e.target.value),
      }
      return h('span', { className: 'tg-field' },
        P.Input ? h(P.Input, attrs) : h('input', Object.assign({ className: 'tg-input' }, attrs)))
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
          className: 'tg-input',
          value: props.value,
          disabled: disabled,
          onChange: (e) => props.onChange(e.target.value),
        }, options.map((o) => h('option', { key: o.id, value: o.id }, o.name)))
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
          className: 'tg-selector',
          'aria-haspopup': 'menu',
          'aria-expanded': open,
          disabled: disabled,
          onClick: () => setOpen((v) => !v),
        },
          h('span', { className: 'tg-selector-label' }, current ? current.name : ''),
          P.IconChevronDownOutline14
            ? h(P.IconChevronDownOutline14, { className: 'tg-chevron' })
            : h('span', { className: 'tg-chevron', 'aria-hidden': true }, '▾')),
      })
    }

    /** On/off as the two-item Menu the harness uses for every other choice. */
    function Toggle(props) {
      return h(Selector, {
        value: props.value ? 'on' : 'off',
        options: [{ id: 'on', name: props.onLabel }, { id: 'off', name: props.offLabel }],
        disabled: props.disabled,
        onChange: (id) => props.onChange(id === 'on'),
      })
    }

    /** Small badge: the harness's Pill, or plain tertiary text. */
    function Tag(props) {
      if (P.Pill) return h(P.Pill, null, props.children)
      return h('span', { className: 'tg-desc' }, props.children)
    }

    /** Label left, control right — the canonical settings row. */
    function Row(props) {
      return h('div', { className: 'tg-row' },
        h('div', { className: 'tg-row-text' },
          props.title === undefined ? null : h('div', { className: 'tg-title' }, props.title),
          props.desc === undefined ? null : h('div', { className: 'tg-desc' }, props.desc)),
        props.children)
    }

    // ------------------------------------------------------------ component
    function TailnetSection(props) {
      const { t } = props
      const [view, setView] = React.useState({ status: 'unavailable', value: {}, writable: false, runtime: {} })
      const [peers, setPeers] = React.useState({ available: false, devices: [], ownerLogin: '', you: '' })
      // Held as text because a half-typed list is not the same as an empty one,
      // and an empty one means something specific here ("the node's owner").
      const [loginsText, setLoginsText] = React.useState('')
      const seeded = React.useRef(false)
      const pending = React.useRef(null)
      const alive = React.useRef(true)

      const value = view.value || {}
      const runtime = view.runtime || {}
      const writable = view.writable === true
      const devices = peers.devices || []
      const allowedDevices = Array.isArray(value.allowedDevices) ? value.allowedDevices : []

      const refresh = React.useCallback(() => {
        loadJson(CONFIG_ROUTE, null).then((v) => { if (v && alive.current) setView(v) })
        loadJson(DEVICES_ROUTE, null).then((p) => { if (p && alive.current) setPeers(p) })
      }, [])

      React.useEffect(() => {
        alive.current = true
        refresh()
        return () => { alive.current = false }
      }, [refresh])

      // Seeded once from the first ready view, then owned by the field: the
      // response to a write arrives mid-typing and would otherwise snap the
      // box back to the value already sent.
      React.useEffect(() => {
        if (seeded.current || view.status !== 'ready') return
        seeded.current = true
        setLoginsText((Array.isArray(value.allowedLogins) ? value.allowedLogins : []).join(', '))
      }, [view, value.allowedLogins])

      /**
       * Post a partial change. The route rejects anything that would lock the
       * caller out, so a refusal is worth showing rather than swallowing.
       */
      const save = React.useCallback((patch) => {
        return fetch(CONFIG_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(patch),
        })
          .then((r) => r.json().then((body) => (r.ok ? body : Promise.reject(new Error(body.error || String(r.status))))))
          .then((v) => { if (alive.current) setView(v) })
          .catch((error) => {
            try { console.warn('[dsh-tailnet-gateway] write refused:', error) } catch (ignored) { /* no console */ }
            // Show what the host actually holds rather than leaving the control
            // sitting on a value that was never written.
            refresh()
          })
      }, [refresh])

      const onLoginsChange = (raw) => {
        setLoginsText(raw)
        if (pending.current !== null) clearTimeout(pending.current)
        pending.current = setTimeout(() => {
          pending.current = null
          save({ allowedLogins: String(raw).split(',').map((s) => s.trim()).filter((s) => s !== '') })
        }, WRITE_DELAY_MS)
      }

      const toggleDevice = (name) => {
        const has = allowedDevices.some((entry) => entry.toLowerCase() === name.toLowerCase())
        save({
          allowedDevices: has
            ? allowedDevices.filter((entry) => entry.toLowerCase() !== name.toLowerCase())
            : allowedDevices.concat([name]),
        })
      }

      const statusText = value.enabled === false
        ? t('statusDisabled')
        : runtime.listening
          ? t('statusOn') + ' ' + String(runtime.host || '') + ':' + String(runtime.port || '') + ' → ' + String(runtime.upstream || '')
          : t('statusOff') + (runtime.error ? ' — ' + runtime.error : '')

      return h('div', { className: 'tg-section' },
        h('h2', { className: 'tg-heading' }, t('title')),
        h('p', { className: 'tg-intro' }, t('description')),
        !writable ? h('p', { className: 'tg-readonly' }, t('readOnly')) : null,
        h('div', { className: 'tg-status' },
          h('div', { className: 'tg-status-line' },
            P.StateDot ? h(P.StateDot, { state: runtime.listening ? 'success' : 'idle' }) : null,
            h('span', null, statusText)),
          runtime.listening
            ? h('div', { className: 'tg-status-line' },
                h('span', null, t('serveHint')),
                h('code', { className: 'tg-code' }, 'tailscale serve --bg ' + String(runtime.port || '')))
            : null),

        h('div', { className: 'tg-stack' },
          h(Row, { title: t('enabledLabel'), desc: t('enabledNote') },
            h(Toggle, {
              value: value.enabled !== false, disabled: !writable,
              onLabel: t('on'), offLabel: t('off'),
              onChange: (next) => save({ enabled: next }),
            }))),

        h('h3', { className: 'tg-subheading' }, t('loginHeading')),
        h('div', { className: 'tg-stack' },
          h(Row, { title: t('requireLoginLabel'), desc: t('requireLoginNote') },
            h(Toggle, {
              value: value.requireLogin !== false, disabled: !writable,
              onLabel: t('on'), offLabel: t('off'),
              onChange: (next) => save({ requireLogin: next }),
            })),
          h(Row, { title: t('loginsLabel'), desc: t('loginsNote') },
            h(Text, {
              value: loginsText, disabled: !writable,
              placeholder: peers.ownerLogin || t('loginsPlaceholder'),
              onChange: onLoginsChange,
            }))),

        h('h3', { className: 'tg-subheading' }, t('deviceHeading')),
        h('div', { className: 'tg-stack' },
          h(Row, { title: t('deviceListLabel'), desc: t('deviceListNote') },
            h(Toggle, {
              value: value.deviceAllowlist === true, disabled: !writable,
              onLabel: t('on'), offLabel: t('off'),
              onChange: (next) => save({ deviceAllowlist: next }),
            })),
          !peers.available ? h(Row, { desc: t('devicesUnavailable') }) : null,
          devices.map((device) => {
            const on = allowedDevices.some((entry) => entry.toLowerCase() === device.name.toLowerCase())
            const notes = [device.os, device.tagged ? device.tags.join(' ') : device.login]
              .filter((part) => part !== '' && part !== undefined)
            return h(Row, { key: device.name, title: device.name, desc: notes.join(' · ') },
              h('span', { className: 'tg-pills' },
                device.self ? h(Tag, null, t('thisNode')) : null,
                device.name === peers.you ? h(Tag, null, t('you')) : null),
              h(Btn, {
                variant: on ? 'primary' : 'outline',
                disabled: !writable,
                onClick: () => toggleDevice(device.name),
              }, on ? t('allowed') : t('blocked')))
          })),

        h('h3', { className: 'tg-subheading' }, t('advancedHeading')),
        h('div', { className: 'tg-stack' },
          h(Row, { title: t('trustLabel'), desc: t('trustNote') },
            h(Toggle, {
              value: value.trustGatewayClients !== false, disabled: !writable,
              onLabel: t('on'), offLabel: t('off'),
              onChange: (next) => save({ trustGatewayClients: next }),
            }))))
    }

    // ------------------------------------------------------------------ apply

    const inject = ['slots', 'locale']

    function apply(ctx) {
      // `register` throws when the namespace already carries this locale, which
      // is what a client reload does. It must not share a `try` with the slot
      // registration below: that would turn a re-register into a missing
      // Settings page. `ctx.effect` also unregisters it when the plugin unloads.
      try {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-tailnet-gateway: locale')
      } catch (error) {
        console.warn('[dsh-tailnet-gateway] locale unavailable; falling back to keys:', error)
      }
      try {
        // `settings.section` is the only slot that produces a top-level
        // Settings nav entry.
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-tailnet-gateway',
              order: 210,
              label: () => ctx.locale.bind(NS)('nav'),
              locale: NS,
            },
            TailnetSection,
          ),
        )
      } catch (error) {
        console.warn('[dsh-tailnet-gateway] settings page failed to mount:', error)
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
