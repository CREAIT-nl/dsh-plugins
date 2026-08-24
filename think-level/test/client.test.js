/**
 * The browser half, rendered.
 *
 * Every test here is about one of the two things the pill has to get right and
 * a unit test of the host cannot see: WHICH level the composer offers, and WHEN
 * it is allowed to write one. The second is the whole reason the pill exists —
 * both shipped model pickers stamp the adapter's default effort into the
 * selection on a model change, so without a re-apply the configured table would
 * be shadowed forever, and with a careless one an effort picked by hand would
 * be thrown away.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createRoot, find } from './mini-react.js';

const SRC = fs.readFileSync(fileURLToPath(new URL('../client/client.cjs', import.meta.url)), 'utf8');

/**
 * A stub of the primitives seed module, shaped like the parts the bundle uses.
 *
 * Not the harness's real components — the browser check covers whether the
 * props match. What this covers is that the primitives *branch executes*: with
 * the seed absent the page draws a native `<select>` and a plain button, so
 * `Selector`'s Menu path and the two icons would otherwise never run in a test.
 */
function makePrimitives(React) {
  const h = React.createElement
  return {
    Button: (props) => h('button', { 'data-primitive': 'Button', ...props }, props.children),
    Menu: (props) => h('div', { 'data-primitive': 'Menu', menu: props }, props.anchor),
    IconChevronDownOutline14: (props) => h('svg', { 'data-primitive': 'Chevron', ...props }),
    IconThinkOutline16: (props) => h('svg', { 'data-primitive': 'Think', ...props }),
  }
}

/** Boot the bundle against a fresh stub world; returns what apply() registered. */
function boot(options = {}) {
  const root = createRoot()
  const slots = []
  const warnings = []
  const requests = []
  const services = Object.assign({}, options.services)

  const loader = { loaded: null, load(entry) { loader.loaded = entry } }
  // The two surfaces talk to each other over one window event, so the stub
  // window needs a real bus rather than a no-op pair.
  const listeners = new Map()
  const win = {
    __ModuleLoader__: loader,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatchEvent(event) { for (const fn of listeners.get(event.type) ?? []) fn(event); },
  }
  class CustomEventStub {
    constructor(type) { this.type = type }
  }
  // The menu closes on a document-level press or Escape, so the stub document
  // needs a real bus too — otherwise that path is untestable.
  const docListeners = new Map()
  const doc = {
    head: { appendChild() {} },
    querySelector() { return null },
    createElement() { return { dataset: {}, textContent: '' } },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, new Set());
      docListeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { docListeners.get(type)?.delete(fn); },
  }
  const fetchStub = (url, init) => {
    requests.push({ url, method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : undefined })
    const answer = options.routes ? options.routes(url, init) : null
    return Promise.resolve({
      ok: answer !== null && answer !== undefined,
      status: answer === null || answer === undefined ? 500 : 200,
      json: () => Promise.resolve(answer === null || answer === undefined ? { error: 'stub' } : answer),
    })
  }
  const consoleStub = { warn: (...args) => warnings.push(args.join(' ')), error: () => {} }

  const run = new Function('window', 'require', 'fetch', 'document', 'console', 'CustomEvent', SRC)
  // The seed module: resolved by the shell exactly like `react`, so in a
  // browser it is always there. Serving it only on request keeps both arms
  // reachable — the fallback markup most of this file measures, and the
  // primitives path that actually ships.
  const primitives = options.primitives ? makePrimitives(root.React) : null
  const requireStub = (name) => {
    if (name === 'react') return root.React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      if (primitives === null) throw new Error('seed module absent')
      return primitives
    }
    throw new Error('unexpected require: ' + name)
  }
  run(win, requireStub, fetchStub, doc, consoleStub, CustomEventStub)

  const ctx = {
    effect(fn) { fn(); return () => {} },
    locale: { register() { return () => {} }, bind: () => (key) => key },
    slots: {
      inject(name, fn) { fn() },
      register(meta, component) { slots.push({ meta, component }); return () => {} },
    },
    get(name) { return services[name] },
    inject(names, fn) {
      if (names.every((n) => n === 'slots' || n === 'locale' || services[n] !== undefined)) fn(ctx)
    },
  }
  loader.loaded.factory(requireStub).apply(ctx)
  const fire = (type, event) => { for (const fn of docListeners.get(type) ?? []) fn(event) }
  return { root, slots, warnings, requests, primitives, window: win, fire, componentFor: (name) => (slots.find((s) => s.meta.name === name) || {}).component }
}

/** A model directory stub over one mutable snapshot. */
function makeDirectory(current, groups) {
  const listeners = new Set()
  let snapshot = { current, groups }
  const selects = []
  return {
    selects,
    directory: {
      store: {
        subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
        getSnapshot() { return snapshot },
      },
      load: () => Promise.resolve(),
      select(selection) {
        selects.push(selection)
        snapshot = { current: Object.assign({}, selection), groups: snapshot.groups }
        for (const fn of listeners) fn()
        return Promise.resolve()
      },
    },
    set(next) { snapshot = next; for (const fn of listeners) fn() },
  }
}

const LEVELS = [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }]
const GROUPS = [{
  id: 'dgx',
  name: 'DGX',
  models: [
    { id: 'm1', name: 'M One', reasoning: { efforts: LEVELS, defaultEffort: 'high' } },
    { id: 'm2', name: 'M Two', reasoning: { efforts: LEVELS, defaultEffort: 'high' } },
    { id: 'plain', name: 'Plain' },
  ],
}]

function configRoute(rows) {
  return (url) => (String(url).startsWith('/api/dsh-think-level/config')
    ? { status: 'ready', value: { defaults: rows }, writable: true, revision: 1 }
    : null)
}

const SUGGESTED = { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'max' }

/** The config route plus a `levels` view for the model with none. */
function levelsRoute(rows, view) {
  const config = configRoute(rows)
  return (url, init) => {
    if (!String(url).startsWith('/api/dsh-think-level/levels')) return config(url, init)
    return Object.assign({ supported: [], declared: null, suggested: SUGGESTED }, view)
  }
}

async function settle() { for (let i = 0; i < 8; i += 1) await Promise.resolve() }

function pillProps(sessionId) {
  return {
    sessionId,
    t: (key) => key,
    useSession: (select) => select({ subagent: null, removed: false }),
  }
}

function mount(booted, name, props) {
  return booted.root.render(booted.root.React.createElement(booted.componentFor(name), props))
}

// The composer control is a menu, not a select: read the trigger, click it
// open, then read or click the rows. These four helpers are the whole API the
// pill tests need.
function byClass(node, className) {
  return find(node, (n) => n.props
    && typeof n.props.className === 'string'
    && n.props.className.split(' ').indexOf(className) !== -1)
}

function trigger(booted) {
  return byClass(booted.root.rerender(), 'tl-pill')[0]
}

function textOf(node, className) {
  const hit = byClass(node, className)[0]
  return hit === undefined ? undefined : String(hit.children)
}

/** Opens the menu and returns its rows as `{ label, note, checked, click }`. */
function openMenu(booted) {
  trigger(booted).props.onClick()
  return byClass(booted.root.rerender(), 'tl-item').map((item) => ({
    label: textOf(item, 'tl-item-label'),
    note: textOf(item, 'tl-item-note'),
    checked: byClass(item, 'tl-check').length > 0,
    click: () => item.props.onClick(),
  }))
}

test('apply registers the settings page and the composer pill left of research width', () => {
  const dir = makeDirectory({ provider: 'dgx', model: 'm1' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: configRoute([]),
  })
  const section = booted.slots.find((s) => s.meta.name === 'settings.section')
  const pill = booted.slots.find((s) => s.meta.name === 'conversation.input.right')
  assert.ok(section, 'settings.section registered')
  assert.equal(section.meta.id, 'dsh-think-level')
  assert.ok(pill, 'conversation.input.right registered')
  assert.equal(pill.meta.id, 'think-level')
  assert.equal(pill.meta.order, 10, 'order 10 sits left of research-mode width at 20')
  assert.deepEqual(booted.warnings, [])
})

test('the settings page still mounts without the model-selection service', () => {
  const booted = boot({ services: {}, routes: configRoute([]) })
  assert.ok(booted.componentFor('settings.section'), 'settings page survives')
  assert.equal(booted.componentFor('conversation.input.right'), undefined, 'pill declines to mount')
})

test('a model with no thinking levels keeps the pill, disabled and saying why', async () => {
  // Rendering nothing here made the control come and go with the model, which
  // reads as the plugin having broken rather than the model having nothing to
  // offer. It stays put and explains itself instead.
  const dir = makeDirectory({ provider: 'dgx', model: 'plain' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: configRoute([]),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  const button = trigger(booted)
  assert.ok(button, 'the pill is still there')
  assert.equal(button.props.disabled, true)
  assert.equal(textOf(button, 'tl-text'), 'noLevels')
  assert.match(String(button.props.title), /noLevelsHint/)
  assert.equal(byClass(booted.root.rerender(), 'tl-menu').length, 0, 'nothing to open')
})

test('a model whose levels can be declared offers to declare them', async () => {
  // The dead end this replaces: a hand-declared route publishes no levels, so
  // the pill had nothing to pick and the answer was "go edit settings.yaml".
  // pi-ai reads that capability out of a settings namespace, so the pill can
  // write it — one click, live on the next request.
  const dir = makeDirectory({ provider: 'dgx', model: 'plain' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: levelsRoute([], { shape: 'models', writable: true }),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()

  const button = trigger(booted)
  assert.equal(button.props.disabled, false, 'live, not disabled')
  assert.match(String(button.props.title), /enableHint/)
  const rows = openMenu(booted)
  assert.deepEqual(rows.map((row) => row.label), ['enable'])
  assert.equal(rows[0].note, 'enableNote')

  rows[0].click()
  await settle()
  const posted = booted.requests.filter((request) => request.method === 'POST')
  assert.equal(posted.length, 1)
  assert.match(String(posted[0].url), /provider=dgx&model=plain/)
  assert.deepEqual(posted[0].body, { efforts: SUGGESTED })
})

test('a model another adapter owns says so, and offers nothing', async () => {
  const dir = makeDirectory({ provider: 'dgx', model: 'plain' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: levelsRoute([], { shape: null, reason: 'no-route', writable: false }),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  const button = trigger(booted)
  assert.equal(button.props.disabled, true)
  assert.match(String(button.props.title), /noLevelsHint/)
  button.props.onClick()
  assert.equal(byClass(booted.root.rerender(), 'tl-menu').length, 0, 'no menu to open')
})

test('unpinned effort shows auto, labelled with the level that will actually apply', async () => {
  const dir = makeDirectory({ provider: 'dgx', model: 'm1' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: configRoute([]),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  assert.equal(textOf(trigger(booted), 'tl-text'), 'auto · High', 'auto names the level that applies')
  const rows = openMenu(booted)
  assert.deepEqual(rows.map((row) => row.label), ['auto', 'Off', 'Low', 'High'])
  assert.equal(rows[0].note, 'High', 'the auto row names the provider default')
  assert.deepEqual(rows.map((row) => row.checked), [true, false, false, false], 'auto is the current state')
})

test('a configured default fills an empty effort and labels auto with it', async () => {
  const dir = makeDirectory({ provider: 'dgx', model: 'm1' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: configRoute([{ provider: 'dgx', model: 'm1', effort: 'low' }]),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  assert.deepEqual(dir.selects, [{ provider: 'dgx', model: 'm1', reasoningEffort: 'low' }])
})

test('an effort already pinned survives first sight of the session', async () => {
  const dir = makeDirectory({ provider: 'dgx', model: 'm1', reasoningEffort: 'high' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: configRoute([{ provider: 'dgx', model: 'm1', effort: 'low' }]),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  assert.deepEqual(dir.selects, [], 'a deliberate pick is not clobbered on reload')
})

test('changing model re-applies the configured default over the picker default', async () => {
  const dir = makeDirectory({ provider: 'dgx', model: 'm1', reasoningEffort: 'high' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: configRoute([
      { provider: 'dgx', model: 'm1', effort: 'low' },
      { provider: 'dgx', model: 'm2', effort: 'off' },
    ]),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  assert.deepEqual(dir.selects, [], 'still nothing on first sight')
  // What the shipped model pickers do on a model change: pin the adapter default.
  dir.set({ current: { provider: 'dgx', model: 'm2', reasoningEffort: 'high' }, groups: GROUPS })
  await settle()
  booted.root.rerender()
  await settle()
  assert.deepEqual(dir.selects, [{ provider: 'dgx', model: 'm2', reasoningEffort: 'off' }])
})

test('picking a level writes it, and auto clears it', async () => {
  const dir = makeDirectory({ provider: 'dgx', model: 'm1', reasoningEffort: 'high' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: configRoute([]),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  assert.equal(textOf(trigger(booted), 'tl-text'), 'High')
  const rows = openMenu(booted)
  assert.deepEqual(rows.map((row) => row.checked), [false, false, false, true], 'the pinned level is ticked')
  rows[2].click()
  assert.deepEqual(dir.selects.at(-1), { provider: 'dgx', model: 'm1', reasoningEffort: 'low' })
  await settle()
  assert.equal(byClass(booted.root.rerender(), 'tl-menu').length, 0, 'picking closes the menu')
  openMenu(booted)[0].click()
  assert.deepEqual(dir.selects.at(-1), { provider: 'dgx', model: 'm1' }, 'auto sends no effort at all')
})

test('Escape and an outside press close the menu, the way the harness\'s own do', async () => {
  const dir = makeDirectory({ provider: 'dgx', model: 'm1' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: configRoute([]),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  openMenu(booted)
  assert.equal(byClass(booted.root.rerender(), 'tl-menu').length, 1, 'open')
  booted.fire('keydown', { key: 'Escape' })
  assert.equal(byClass(booted.root.rerender(), 'tl-menu').length, 0, 'Escape closes it')
  openMenu(booted)
  booted.fire('mousedown', { target: { } })
  assert.equal(byClass(booted.root.rerender(), 'tl-menu').length, 0, 'a press elsewhere closes it')
  assert.deepEqual(dir.selects, [], 'closing pins nothing')
})

test('auto sends the table\'s answer, because the host will not leave the field empty', async () => {
  // Sending nothing would let the host materialize the ADAPTER default (high
  // here), which is not what the option said. `auto` has to name the level it
  // promised.
  const dir = makeDirectory({ provider: 'dgx', model: 'm1', reasoningEffort: 'max' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: configRoute([{ provider: 'dgx', model: 'm1', effort: 'low' }]),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  const rows = openMenu(booted)
  assert.equal(rows[0].note, 'Low', 'auto promises the configured level')
  rows[0].click()
  assert.deepEqual(dir.selects.at(-1), { provider: 'dgx', model: 'm1', reasoningEffort: 'low' })
})

test('a level the model no longer publishes is ignored rather than shown', async () => {
  const dir = makeDirectory({ provider: 'dgx', model: 'm1' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: configRoute([{ provider: 'dgx', model: 'm1', effort: 'ultra' }]),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  assert.deepEqual(dir.selects, [], 'a stale row never reaches the selection')
  assert.equal(openMenu(booted)[0].note, 'High', 'auto falls back to the provider default')
})

test('the settings page lists configured rows and offers the levels of a chosen model', async () => {
  const booted = boot({
    services: {},
    routes: (url) => {
      const text = String(url)
      if (text.startsWith('/api/dsh-think-level/config')) {
        return { status: 'ready', value: { defaults: [{ provider: 'dgx', model: 'm1', effort: 'low' }] }, writable: true, revision: 3 }
      }
      if (text.startsWith('/api/dsh-think-level/catalog')) {
        return { providers: [{ id: 'dgx', name: 'DGX' }], models: { dgx: [{ id: 'm1', name: 'M One' }, { id: 'm2', name: 'M Two' }] } }
      }
      if (text.startsWith('/api/dsh-think-level/efforts')) return { efforts: LEVELS, defaultEffort: 'high' }
      return null
    },
  })
  mount(booted, 'settings.section', { t: (key) => key })
  await settle()
  const tree = booted.root.rerender()
  // Scoped to the configured table: `tl-title` is the harness's row-title
  // class, so the page's other rows carry it too.
  const rows = find(tree, (n) => n.props && n.props.className === 'tl-rows')[0]
  const labels = find(rows, (n) => n.props && n.props.className === 'tl-title')
  assert.deepEqual(labels.map((n) => n.children), ['dgx / m1'])
  // Either shape: with primitives the page draws a `Selector` (the harness
  // ships no styled `<select>`), and without them — as here, where the require
  // stub serves react alone — it falls back to a native one.
  const rowSelect = find(rows, (n) => n.props && n.props.value === 'low'
    && (n.type === 'select' || typeof n.type === 'function'))[0]
  assert.ok(rowSelect, 'the row shows the level it stores')
  const efforts = booted.requests.filter((r) => String(r.url).startsWith('/api/dsh-think-level/efforts'))
  assert.equal(efforts.length, 1, 'one round-trip for the one row on screen')
  assert.match(String(efforts[0].url), /provider=dgx&model=m1/)
})

test('the pill follows a table edit made on the Settings page', async () => {
  // Same table, two mounts, no service between them: without the event the
  // pill would keep advertising the provider default while the host had
  // already started applying the row that was just added.
  const dir = makeDirectory({ provider: 'dgx', model: 'm1' }, GROUPS)
  let rows = []
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: (url) => (String(url).startsWith('/api/dsh-think-level/config')
      ? { status: 'ready', value: { defaults: rows }, writable: true, revision: 1 }
      : null),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  assert.equal(textOf(trigger(booted), 'tl-text'), 'auto · High', 'the provider default, to start with')

  rows = [{ provider: 'dgx', model: 'm1', effort: 'low' }]
  booted.window.dispatchEvent({ type: 'dsh-think-level:changed' })
  await settle()
  assert.equal(textOf(trigger(booted), 'tl-text'), 'auto · Low', 'the configured level, once the table has one')
  assert.deepEqual(dir.selects, [], 'a table edit relabels the pill; it pins nothing')
})

test('saving the table announces it', async () => {
  const booted = boot({
    services: {},
    routes: (url) => {
      const text = String(url)
      if (text.startsWith('/api/dsh-think-level/config')) {
        return { status: 'ready', value: { defaults: [{ provider: 'dgx', model: 'm1', effort: 'low' }] }, writable: true, revision: 1 }
      }
      if (text.startsWith('/api/dsh-think-level/catalog')) return { providers: [{ id: 'dgx', name: 'DGX' }], models: { dgx: [{ id: 'm1', name: 'M One' }] } }
      if (text.startsWith('/api/dsh-think-level/efforts')) return { efforts: LEVELS, defaultEffort: 'high' }
      return null
    },
  })
  const heard = []
  booted.window.addEventListener('dsh-think-level:changed', (event) => heard.push(event.type))
  mount(booted, 'settings.section', { t: (key) => key })
  await settle()
  const remove = find(booted.root.rerender(), (n) => n.type === 'button' && n.children === 'remove')[0]
  assert.ok(remove, 'the configured row offers a remove button')
  remove.props.onClick()
  await settle()
  assert.deepEqual(heard, ['dsh-think-level:changed'])
  const posts = booted.requests.filter((r) => r.method === 'POST')
  assert.deepEqual(posts.at(-1).body, { defaults: [] }, 'removing the only row posts an empty table')
})

// Every test above this line runs with the seed module absent, which is the
// fallback arm: a native `<select>` and a plain button. In a browser the seed
// always resolves, so the arm that actually ships is the one no test measured.
// These do.

test('the settings page draws a portalled Menu, not a native select, with the seed module', async () => {
  const booted = boot({
    primitives: true,
    routes: (url) => {
      const text = String(url)
      if (text.startsWith('/api/dsh-think-level/config')) return { status: 'ready', value: { defaults: [] }, writable: true, revision: 1 }
      if (text.startsWith('/api/dsh-think-level/catalog')) return { providers: [{ id: 'dgx', name: 'DGX' }], models: { dgx: [{ id: 'm1', name: 'M One' }] } }
      if (text.startsWith('/api/dsh-think-level/efforts')) return { efforts: LEVELS, defaultEffort: 'high' }
      return null
    },
  })
  mount(booted, 'settings.section', { t: (key) => key })
  await settle()
  const tree = booted.root.rerender()
  const menus = find(tree, (n) => n.props && n.props['data-primitive'] === 'Menu')
  assert.ok(menus.length > 0, 'the primitives path must draw a Menu')
  assert.equal(find(tree, (n) => n.type === 'select').length, 0, 'and no native select alongside it')
  // Portal is what keeps the menu from clipping inside the settings panel.
  for (const menu of menus) assert.equal(menu.props.menu.portal, true)
})

test('a dropdown offers the catalog as menu items and reports only a real change', async () => {
  const booted = boot({
    primitives: true,
    routes: (url) => {
      const text = String(url)
      if (text.startsWith('/api/dsh-think-level/config')) return { status: 'ready', value: { defaults: [] }, writable: true, revision: 1 }
      if (text.startsWith('/api/dsh-think-level/catalog')) {
        return { providers: [{ id: 'dgx', name: 'DGX' }, { id: 'cloud', name: 'Cloud' }], models: { dgx: [{ id: 'm1', name: 'M One' }] } }
      }
      if (text.startsWith('/api/dsh-think-level/efforts')) return { efforts: LEVELS, defaultEffort: 'high' }
      return null
    },
  })
  mount(booted, 'settings.section', { t: (key) => key })
  await settle()
  const menu = find(booted.root.rerender(), (n) => n.props && n.props['data-primitive'] === 'Menu')[0].props.menu
  assert.deepEqual(menu.items.map((item) => ({ id: item.id, label: item.label })), [{ id: 'dgx', label: 'DGX' }, { id: 'cloud', label: 'Cloud' }])
  assert.equal(menu.selectedId, 'dgx', 'the provider defaults to the first in the catalog')
  // An unpicked dropdown must pass `undefined`, never the empty string: a Menu
  // would try to match '' against an item id and highlight nothing coherently.
  const menus = find(booted.root.rerender(), (n) => n.props && n.props['data-primitive'] === 'Menu')
  assert.equal(menus.some((entry) => entry.props.menu.selectedId === ''), false)
})

test('the pill draws the seed module think icon rather than its inline copy', async () => {
  // One mark across the pill, the Settings nav row and the harness's own
  // thinking affordances — which only holds if the shell's glyph is used where
  // the shell serves it. The hand-drawn brain is the fallback, not the default.
  const dir = makeDirectory({ provider: 'dgx', model: 'plain' }, GROUPS)
  const booted = boot({
    primitives: true,
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: levelsRoute([], { shape: 'models', writable: true }),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  const icons = find(booted.root.rerender(), (n) => n.props && n.props['data-primitive'] === 'Think')
  assert.equal(icons.length, 1)
  assert.equal(icons[0].props.className, 'tl-icon')
  assert.equal(icons[0].props.size, 14)
})

test('the pill keeps its own glyph when the seed module is absent', async () => {
  const dir = makeDirectory({ provider: 'dgx', model: 'plain' }, GROUPS)
  const booted = boot({
    services: { conversation: {}, modelDirectories: { directoryFor: () => dir.directory } },
    routes: levelsRoute([], { shape: 'models', writable: true }),
  })
  mount(booted, 'conversation.input.right', pillProps('s1'))
  await settle()
  const icons = byClass(booted.root.rerender(), 'tl-icon')
  assert.equal(icons.length, 1)
  assert.equal(icons[0].type, 'svg', 'the inline brain, drawn rather than missing')
})

test('the settings buttons come from the seed module, and still work when it is absent', async () => {
  const routes = (url) => {
    const text = String(url)
    if (text.startsWith('/api/dsh-think-level/config')) {
      return { status: 'ready', value: { defaults: [{ provider: 'dgx', model: 'm1', effort: 'low' }] }, writable: true, revision: 1 }
    }
    if (text.startsWith('/api/dsh-think-level/catalog')) return { providers: [{ id: 'dgx', name: 'DGX' }], models: { dgx: [{ id: 'm1', name: 'M One' }] } }
    if (text.startsWith('/api/dsh-think-level/efforts')) return { efforts: LEVELS, defaultEffort: 'high' }
    return null
  }
  const seeded = boot({ primitives: true, routes })
  mount(seeded, 'settings.section', { t: (key) => key })
  await settle()
  const fromSeed = find(seeded.root.rerender(), (n) => n.props && n.props['data-primitive'] === 'Button')
  assert.ok(fromSeed.length > 0, 'the buttons are the primitive')

  const plain = boot({ routes })
  mount(plain, 'settings.section', { t: (key) => key })
  await settle()
  const fallback = find(plain.root.rerender(), (n) => n.type === 'button' && n.children === 'remove')
  assert.equal(fallback.length, 1, 'and the same page still offers them without it')
})

