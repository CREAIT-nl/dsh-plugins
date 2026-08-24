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
  const requireStub = (name) => {
    if (name === 'react') return root.React
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
  return { root, slots, warnings, requests, window: win, fire, componentFor: (name) => (slots.find((s) => s.meta.name === name) || {}).component }
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
