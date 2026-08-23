/**
 * Just enough React to drive the client bundle's hooks synchronously in Node.
 *
 * The bundle is plain browser JS with no build step, so the cheapest way to pin
 * its behaviour is to run it: give it a `window`, a `fetch` and a `react`,
 * render a component, and read what came out. This is that `react` — state,
 * refs, effects and an external store, rendered eagerly to a plain tree until
 * nothing schedules another pass.
 */
export function createRoot() {
  const store = new Map()
  let root = null
  let rendering = false
  let dirty = false
  const pendingEffects = []

  const React = {
    createElement(type, props, ...children) {
      const p = Object.assign({}, props)
      if (children.length === 1) p.children = children[0]
      else if (children.length > 1) p.children = children
      return { type, props: p }
    },
    useState(initial) {
      const slot = claim(typeof initial === 'function' ? initial() : initial)
      const set = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        schedule()
      }
      return [slot.value, set]
    },
    useRef(initial) {
      return claim({ current: initial }).value
    },
    useCallback(fn) { return fn },
    useMemo(fn) { return fn() },
    useEffect(fn, deps) {
      const slot = claim({ deps: undefined, cleanup: undefined, first: true })
      const prev = slot.value
      const changed = prev.first || deps === undefined || prev.deps === undefined ||
        deps.length !== prev.deps.length || deps.some((d, i) => !Object.is(d, prev.deps[i]))
      prev.first = false
      prev.deps = deps
      if (changed) pendingEffects.push(() => {
        if (typeof prev.cleanup === 'function') prev.cleanup()
        prev.cleanup = fn()
      })
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      const slot = claim({ subscribed: false })
      if (!slot.value.subscribed) {
        slot.value.subscribed = true
        pendingEffects.push(() => subscribe(() => schedule()))
      }
      return getSnapshot()
    },
  }

  let ctxKey = ''
  let ctxIndex = 0
  function claim(initial) {
    const hooks = store.get(ctxKey) || []
    store.set(ctxKey, hooks)
    if (hooks.length <= ctxIndex) hooks.push({ value: initial })
    return hooks[ctxIndex++]
  }

  function schedule() {
    dirty = true
    if (!rendering) flush()
  }

  function walk(el, path) {
    if (el === null || el === undefined || typeof el !== 'object') return el
    if (Array.isArray(el)) return el.map((child, i) => walk(child, path + '/' + i))
    if (typeof el.type === 'function') {
      const key = path + '#' + (el.type.name || 'anon')
      const savedKey = ctxKey, savedIndex = ctxIndex
      ctxKey = key; ctxIndex = 0
      const out = el.type(el.props || {})
      ctxKey = savedKey; ctxIndex = savedIndex
      return walk(out, key)
    }
    const props = el.props || {}
    return { type: el.type, props, children: walk(props.children, path + '/c') }
  }

  function flush() {
    rendering = true
    let guard = 0
    let tree = null
    do {
      dirty = false
      tree = walk(root, '')
      while (pendingEffects.length) pendingEffects.shift()()
      if (++guard > 50) throw new Error('render loop did not settle')
    } while (dirty)
    rendering = false
    return tree
  }

  return {
    React,
    render(element) { root = element; return flush() },
    rerender() { return flush() },
  }
}

/** Depth-first search over a rendered tree. */
export function find(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const child of node) find(child, predicate, out); return out }
  if (predicate(node)) out.push(node)
  find(node.children, predicate, out)
  return out
}

