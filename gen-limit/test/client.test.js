/**
 * The Settings page, driven without a browser.
 *
 * A real browser proved this page renders and that a write lands; both were
 * checked there. What a browser cannot do is hold the clock still, so it cannot
 * show the three things this file exists for: that a half-typed queue field is
 * not written as zero, that closing the panel inside the debounce window
 * flushes the pending edit instead of dropping it, and that the queue write
 * carries no `limits` array — because it shares one route with the limits
 * editor, and posting the array this page happens to be holding would silently
 * revert a limits edit made anywhere else.
 *
 * Everything runs against the shipped `client/client.cjs`, loaded the way the
 * shell loads it, and half the file runs it twice: once with the primitives
 * seed module present, which is what every browser sees, and once without,
 * which is the degraded path the wrappers promise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	CATALOG_ROUTE,
	CONFIG_ROUTE,
	STATS_ROUTE,
	WRITE_DELAY_MS,
	buttonsOf,
	loadClient,
	makeDom,
	makeNavCell,
	numbersOf,
	propsFor,
	renderChild,
	selectorsOf,
	settle,
	textOf,
	walk,
} from './client-harness.js';

const CATALOG = {
	providers: [{ id: 'dgx', name: 'DGX' }, { id: 'cloud', name: 'Cloud' }],
	models: { dgx: [{ id: 'v4-flash', name: 'V4 Flash' }], cloud: [{ id: 'v4', name: 'V4' }] },
};

const viewWith = (limits, extra = {}) => ({ status: 'ready', writable: true, value: { limits, ...extra } });

/** Mount the section with the page's first three reads already answered. */
async function open(options = {}) {
	const harness = loadClient({ catalog: { body: CATALOG }, ...options });
	const instance = harness.mount(harness.Component, propsFor());
	await settle();
	await settle();
	return { ...harness, instance };
}

/** Every POST body the page has sent, in order. */
const writes = (harness) => harness.requests.filter((r) => r.method === 'POST').map((r) => r.body);

describe('registration', () => {
	it('registers under the full package name, which is what the loader looks up', () => {
		// A short id here is the "loaded without registering" failure: the
		// loader checks `factories.has(row.id)` against the package name.
		assert.equal(loadClient().id, '@creait/dsh-gen-limit');
	});

	it('asks for exactly the services it uses, and not the seed module', () => {
		// `@deepseek-ai/dsh-client-ui-primitives` is resolved by the shell like
		// `react`. Naming it in `inject` would make the loader demand a row
		// that does not exist and the plugin would never mount.
		// Spread first: the array is minted inside the vm realm, so it is not
		// reference-equal to a literal built out here.
		assert.deepEqual([...loadClient().inject], ['slots', 'locale']);
	});

	it('registers a top-level settings nav entry, not a plugin card', () => {
		const { descriptor } = loadClient();
		assert.equal(descriptor.name, 'settings.section');
		assert.equal(descriptor.id, 'dsh-gen-limit');
		assert.equal(descriptor.locale, 'dsh-gen-limit');
		assert.equal(typeof descriptor.label, 'function');
	});

	it('still mounts the page when the locale is already registered', () => {
		// A client reload re-registers the namespace and `register` throws.
		// Sharing one `try` with the slot registration turned that into a
		// missing Settings page, which is the bug this pins.
		const harness = loadClient({ locale: 'throws' });
		assert.equal(typeof harness.Component, 'function');
		assert.equal(harness.descriptor.name, 'settings.section');
		assert.ok(harness.warnings.some((w) => w.includes('locale unavailable')));
	});
});

describe('reading the deployment', () => {
	it('reads config, catalog and stats on mount', async () => {
		const { requests } = await open();
		const got = requests.filter((r) => r.method === 'GET').map((r) => r.url);
		assert.deepEqual(new Set(got), new Set([CONFIG_ROUTE, CATALOG_ROUTE, STATS_ROUTE]));
	});

	it('shows the empty-state row when nothing is limited', async () => {
		const { instance } = await open();
		const descs = walk(instance.output).filter((n) => n.props?.desc !== undefined).map((n) => n.props.desc);
		assert.ok(descs.includes('noLimits'));
	});

	it('renders one row per limit, titled provider / model', async () => {
		const { instance } = await open({ config: { body: viewWith([{ provider: 'dgx', model: 'v4-flash', max: 3 }]) } });
		const titles = walk(instance.output).filter((n) => n.props?.title !== undefined).map((n) => n.props.title);
		assert.ok(titles.includes('dgx / v4-flash'));
	});

	it('says so, and disables every control, when the deployment is read-only', async () => {
		const { instance } = await open({ config: { body: { status: 'ready', writable: false, value: { limits: [{ provider: 'dgx', model: 'v4-flash', max: 3 }] } } } });
		assert.ok(textOf(instance, 'gl-readonly').includes('readOnly'));
		for (const node of [...numbersOf(instance), ...selectorsOf(instance), ...buttonsOf(instance)]) {
			assert.equal(node.props.disabled, true, 'every control must be disabled when read-only');
		}
	});

	it('survives a config route that is not answering', async () => {
		// `loadJson` swallows the failure and keeps the fallback, so the page
		// must still render rather than blanking the Settings panel.
		const { instance, warnings } = await open({ config: 'network', stats: 'network', catalog: 'network' });
		assert.ok(walk(instance.output).length > 0);
		assert.deepEqual(warnings, []);
	});
});

describe('the live counters', () => {
	it('polls stats on an interval and stops when the panel closes', async () => {
		const { instance, clock, requests } = await open();
		const before = requests.filter((r) => r.url === STATS_ROUTE).length;
		clock.advance(2000);
		await settle();
		clock.advance(2000);
		await settle();
		assert.equal(requests.filter((r) => r.url === STATS_ROUTE).length, before + 2);
		instance.unmount();
		const after = requests.filter((r) => r.url === STATS_ROUTE).length;
		clock.advance(10000);
		await settle();
		assert.equal(requests.filter((r) => r.url === STATS_ROUTE).length, after, 'the interval must be cleared on unmount');
	});

	it('shows the waiting count only when something is actually waiting', async () => {
		const limits = [{ provider: 'dgx', model: 'v4-flash', max: 1 }];
		let waiting = 0;
		const { instance, clock } = await open({
			config: { body: viewWith(limits) },
			stats: () => ({ body: { entries: [{ provider: 'dgx', model: 'v4-flash', active: 1, waiting }] } }),
		});
		const counts = () => walk(instance.output)
			.filter((n) => n.props?.className === 'gl-pills')
			.flatMap((n) => n.children)
			.filter((c) => c && typeof c === 'object');
		assert.equal(counts().length, 1, 'active only, while nothing waits');
		waiting = 2;
		clock.advance(2000);
		await settle();
		assert.equal(counts().length, 2, 'waiting joins active once the queue is non-empty');
	});
});

describe('editing limits', () => {
	it('writes the edited row and leaves its siblings alone', async () => {
		const harness = await open({
			config: { body: viewWith([{ provider: 'dgx', model: 'v4-flash', max: 3 }, { provider: 'cloud', model: 'v4', max: 9 }]) },
		});
		numbersOf(harness.instance)[0].props.onChange('5');
		await settle();
		assert.deepEqual(writes(harness), [{ limits: [{ provider: 'dgx', model: 'v4-flash', max: 5 }, { provider: 'cloud', model: 'v4', max: 9 }] }]);
	});

	it('reads an unparseable max as unlimited rather than as zero', async () => {
		// `Number(v) || -1`: an empty or junk box means "no limit", never a
		// limit of 0, which would stop the model being usable at all.
		const harness = await open({ config: { body: viewWith([{ provider: 'dgx', model: 'v4-flash', max: 3 }]) } });
		numbersOf(harness.instance)[0].props.onChange('');
		await settle();
		assert.equal(writes(harness)[0].limits[0].max, -1);
	});

	it('drops the row a remove button names', async () => {
		const harness = await open({
			config: { body: viewWith([{ provider: 'dgx', model: 'v4-flash', max: 3 }, { provider: 'cloud', model: 'v4', max: 9 }]) },
		});
		buttonsOf(harness.instance)[0].props.onClick();
		await settle();
		assert.deepEqual(writes(harness), [{ limits: [{ provider: 'cloud', model: 'v4', max: 9 }] }]);
	});

	it('refuses to add a limit before a model is picked', async () => {
		const harness = await open();
		const add = buttonsOf(harness.instance).at(-1);
		add.props.onClick();
		await settle();
		assert.deepEqual(writes(harness), [], 'no provider/model, no write');
	});

	it('adds the picked provider/model and resets the max box', async () => {
		const harness = await open({ config: { body: viewWith([]) } });
		const [provider, model] = selectorsOf(harness.instance);
		// The provider defaults to the first in the catalog; picking a model
		// is what completes the pair.
		assert.equal(provider.props.value, 'dgx');
		model.props.onChange('v4-flash');
		await settle();
		const max = numbersOf(harness.instance).find((n) => n.props.value === '1');
		max.props.onChange('4');
		buttonsOf(harness.instance).at(-1).props.onClick();
		await settle();
		assert.deepEqual(writes(harness), [{ limits: [{ provider: 'dgx', model: 'v4-flash', max: 4 }] }]);
		assert.ok(numbersOf(harness.instance).some((n) => n.props.value === '1'), 'the max box returns to 1 after an add');
	});

	it('clears the model when the provider changes, so a mismatched pair cannot be written', async () => {
		const harness = await open();
		const [provider, model] = selectorsOf(harness.instance);
		model.props.onChange('v4-flash');
		await settle();
		provider.props.onChange('cloud');
		await settle();
		assert.equal(selectorsOf(harness.instance)[1].props.value, '');
		assert.deepEqual(selectorsOf(harness.instance)[1].props.options, CATALOG.models.cloud);
	});
});

describe('the queue fields', () => {
	const opened = (extra) => open({ config: { body: viewWith([], extra) } });

	it('seeds from the first ready view', async () => {
		const { instance } = await opened({ queueTimeoutMs: 30000, maxQueued: 12 });
		const values = numbersOf(instance).map((n) => n.props.value);
		assert.ok(values.includes('30000'));
		assert.ok(values.includes('12'));
	});

	it('does not write while the box is still being typed in', async () => {
		const harness = await opened({ queueTimeoutMs: 0, maxQueued: 4 });
		numbersOf(harness.instance).find((n) => n.props.value === '4').props.onChange('40');
		await settle();
		assert.deepEqual(writes(harness), [], 'the debounce has not elapsed');
	});

	it('writes once the typing settles, and without a limits array', async () => {
		// The queue knobs and the limits editor share one route. Sending the
		// limits this page happens to be holding would revert an edit made
		// anywhere else, so the patch must be the knob alone.
		const harness = await opened({ queueTimeoutMs: 0, maxQueued: 4 });
		numbersOf(harness.instance).find((n) => n.props.value === '4').props.onChange('40');
		harness.clock.advance(WRITE_DELAY_MS);
		await settle();
		assert.deepEqual(writes(harness), [{ maxQueued: 40 }]);
	});

	it('coalesces a burst of typing into one write', async () => {
		// Each keystroke re-arms the timer, so three digits typed inside one
		// window are one write of the final value, not three of the prefixes.
		const harness = await opened({ queueTimeoutMs: 0, maxQueued: 4 });
		for (const typed of ['1', '12', '120']) {
			numbersOf(harness.instance).filter((n) => n.props.wide)[1].props.onChange(typed);
			harness.clock.advance(WRITE_DELAY_MS / 3);
		}
		harness.clock.advance(WRITE_DELAY_MS);
		await settle();
		assert.deepEqual(writes(harness), [{ maxQueued: 120 }]);
	});

	it('treats an emptied box as unfinished typing, never as zero', async () => {
		// Zero is a real setting here — "wait forever" — so writing it because
		// the box is momentarily blank changes the deployment's behaviour on a
		// keystroke the user was in the middle of.
		const harness = await opened({ queueTimeoutMs: 30000, maxQueued: 4 });
		numbersOf(harness.instance).filter((n) => n.props.wide)[0].props.onChange('');
		harness.clock.advance(WRITE_DELAY_MS * 2);
		await settle();
		assert.deepEqual(writes(harness), []);
		assert.equal(numbersOf(harness.instance).filter((n) => n.props.wide)[0].props.value, '');
	});

	it('ignores a box that is not a number at all', async () => {
		const harness = await opened({ queueTimeoutMs: 30000, maxQueued: 4 });
		numbersOf(harness.instance).filter((n) => n.props.wide)[0].props.onChange('soon');
		harness.clock.advance(WRITE_DELAY_MS * 2);
		await settle();
		assert.deepEqual(writes(harness), []);
	});

	it('shows the clamped value, so the box never disagrees with the limiter', async () => {
		const harness = await opened({ queueTimeoutMs: 30000, maxQueued: 4 });
		const wide = () => numbersOf(harness.instance).filter((n) => n.props.wide);
		wide()[0].props.onChange('3.7');
		harness.clock.advance(WRITE_DELAY_MS);
		await settle();
		assert.equal(wide()[0].props.value, '4');
		assert.deepEqual(writes(harness), [{ queueTimeoutMs: 4 }]);
	});

	it('floors each knob where its meaning stops: 0 for the wait, 1 for the depth', async () => {
		const harness = await opened({ queueTimeoutMs: 30000, maxQueued: 4 });
		const wide = () => numbersOf(harness.instance).filter((n) => n.props.wide);
		wide()[0].props.onChange('-500');
		harness.clock.advance(WRITE_DELAY_MS);
		await settle();
		wide()[1].props.onChange('0');
		harness.clock.advance(WRITE_DELAY_MS);
		await settle();
		assert.deepEqual(writes(harness), [{ queueTimeoutMs: 0 }, { maxQueued: 1 }]);
	});

	it('flushes the pending edit when the panel closes, rather than dropping it', async () => {
		// Closing the panel inside the debounce window used to lose the last
		// edit, which reads as the field ignoring you at the moment you
		// finished typing and clicked away.
		const harness = await opened({ queueTimeoutMs: 0, maxQueued: 4 });
		numbersOf(harness.instance).filter((n) => n.props.wide)[1].props.onChange('40');
		harness.instance.unmount();
		await settle();
		assert.deepEqual(writes(harness), [{ maxQueued: 40 }]);
	});

	it('does not touch state when the flushed write answers after the panel closed', async () => {
		const harness = await opened({ queueTimeoutMs: 0, maxQueued: 4 });
		numbersOf(harness.instance).filter((n) => n.props.wide)[1].props.onChange('40');
		const rendered = JSON.stringify(harness.instance.output, (k, v) => (typeof v === 'function' ? '[fn]' : v));
		harness.instance.unmount();
		await settle();
		await settle();
		assert.equal(JSON.stringify(harness.instance.output, (k, v) => (typeof v === 'function' ? '[fn]' : v)), rendered);
	});

	it('reports a failed queue write instead of failing silently', async () => {
		const harness = await open({ config: { body: viewWith([], { queueTimeoutMs: 0, maxQueued: 4 }) }, post: { status: 500 } });
		numbersOf(harness.instance).filter((n) => n.props.wide)[1].props.onChange('40');
		harness.clock.advance(WRITE_DELAY_MS);
		await settle();
		await settle();
		assert.ok(harness.warnings.some((w) => w.includes('queue write failed')));
	});
});

describe('the primitives path', () => {
	/** The props the bundle handed `P.Menu` for the nth Selector on the page. */
	const menuOf = (harness, index) => renderChild(harness, selectorsOf(harness.instance)[index]).output.props;


	it('draws its counters from the seed module Pill when the shell provides it', async () => {
		const harness = await open({
			primitives: true,
			config: { body: viewWith([{ provider: 'dgx', model: 'v4-flash', max: 3 }]) },
			stats: { body: { entries: [{ provider: 'dgx', model: 'v4-flash', active: 1, waiting: 1 }] } },
		});
		const counts = walk(harness.instance.output).filter((n) => n.props?.className === 'gl-pills').flatMap((n) => n.children);
		assert.equal(counts.length, 2);
		for (const count of counts) {
			assert.equal(renderChild(harness, count).output.type, harness.primitives.Pill);
		}
	});

	it('renders a Menu, not a native select, for a dropdown', async () => {
		// The harness ships no styled `<select>`; a settings dropdown is a
		// `.selector` button plus a Menu.
		const harness = await open({ primitives: true });
		assert.ok(menuOf(harness, 0), 'the primitives path must draw a Menu');
		assert.equal(walk(renderChild(harness, selectorsOf(harness.instance)[0]).output).some((n) => n.type === 'select'), false);
	});

	it('portals the menu, so it is not clipped inside the settings panel', async () => {
		const harness = await open({ primitives: true });
		assert.equal(menuOf(harness, 0).portal, true);
	});

	it('offers the catalog as menu items and marks the current one', async () => {
		const harness = await open({ primitives: true });
		const menu = menuOf(harness, 0);
		assert.deepEqual(menu.items.map((item) => ({ id: item.id, label: item.label })), [{ id: 'dgx', label: 'DGX' }, { id: 'cloud', label: 'Cloud' }]);
		assert.equal(menu.selectedId, 'dgx');
	});

	it('closes on select and reports only a real change', async () => {
		const picked = [];
		const harness = await open({ primitives: true });
		const element = selectorsOf(harness.instance)[0];
		const rendered = harness.mount(element.type, { ...element.props, onChange: (id) => picked.push(id) });
		const menu = () => rendered.output.props;
		menu().anchor.props.onClick();
		assert.equal(menu().open, true);
		menu().onSelect('dgx');
		assert.deepEqual(picked, [], 'picking what is already picked is not a change');
		assert.equal(menu().open, false, 'but it still closes the menu');
		menu().anchor.props.onClick();
		menu().onSelect('cloud');
		assert.deepEqual(picked, ['cloud']);
	});

	it('falls back to a native select when the seed module is absent', async () => {
		const harness = await open();
		const rendered = renderChild(harness, selectorsOf(harness.instance)[0]);
		assert.equal(rendered.output.type, 'select');
	});

	it('degrades every wrapper rather than blanking the page', async () => {
		// A missing primitive must never take the Settings page down with it.
		const harness = await open({ config: { body: viewWith([{ provider: 'dgx', model: 'v4-flash', max: 3 }]) } });
		const num = renderChild(harness, numbersOf(harness.instance)[0]);
		assert.equal(walk(num.output).some((n) => n.type === 'input' && n.props.className === 'gl-input'), true);
		const btn = renderChild(harness, buttonsOf(harness.instance)[0]);
		assert.equal(btn.output.type, 'button');
		assert.deepEqual(harness.warnings, []);
	});
});

describe('the nav glyph', () => {
	const BRANCH_START = 'M13.0762 1.37207';

	it('repaints our row and removes the gear dot that would draw through it', () => {
		const cell = makeNavCell('Generation Concurrency', 2);
		const dom = makeDom([cell]);
		loadClient({ dom });
		assert.equal(cell.svg.paths[0].attrs.d.startsWith(BRANCH_START), true);
		assert.equal(cell.svg.paths[0].attrs['fill-rule'], 'evenodd');
		assert.equal(cell.svg.paths[1].removed, true, 'the surplus gear path must go');
		assert.equal(cell.svg.dataset.glNavicon, '1');
	});

	it('matches the row in either locale', () => {
		const cell = makeNavCell('生成并发', 2);
		loadClient({ dom: makeDom([cell]) });
		assert.equal(cell.svg.paths[0].attrs.d.startsWith(BRANCH_START), true);
	});

	it('leaves every other settings row alone', () => {
		const other = makeNavCell('Plugins', 2);
		loadClient({ dom: makeDom([other]) });
		assert.deepEqual(other.svg.paths[0].attrs, {});
		assert.equal(other.svg.paths[1].removed, false);
	});

	it('is idempotent, so a re-render does not re-walk a painted row', () => {
		const cell = makeNavCell('Generation Concurrency', 2);
		const dom = makeDom([cell]);
		loadClient({ dom });
		assert.ok(cell.svg.paths[0].attrs.d.startsWith(BRANCH_START));
		cell.svg.paths[0].attrs.d = 'sentinel';
		dom.mutate();
		assert.equal(cell.svg.paths[0].attrs.d, 'sentinel', 'a flagged row is skipped');
	});

	it('repaints a gear that came back, which is what a panel remount draws', () => {
		// The flag lives on the rendered node, so a remount brings an unflagged
		// gear back and the observer has to catch it. Without this the glyph is
		// correct exactly once per page load.
		const dom = makeDom([makeNavCell('Generation Concurrency', 2)]);
		loadClient({ dom });
		const fresh = makeNavCell('Generation Concurrency', 2);
		dom.cells.length = 0;
		dom.cells.push(fresh);
		dom.mutate();
		assert.ok(fresh.svg.paths[0].attrs.d.startsWith(BRANCH_START));
		assert.equal(fresh.svg.paths[1].removed, true);
	});

	it('watches the whole panel subtree, because the gear comes back on remount', () => {
		const dom = makeDom([]);
		loadClient({ dom });
		// Compared field by field: the options object is minted inside the vm
		// realm, so it is not reference-equal to a literal built out here.
		assert.equal(dom.observer.options.childList, true);
		assert.equal(dom.observer.options.subtree, true);
		assert.equal(dom.observer.target, dom.document.body);
	});

	it('injects its stylesheet exactly once', () => {
		const dom = makeDom([]);
		loadClient({ dom });
		assert.equal(dom.styles.length, 1);
		assert.equal(dom.styles[0].dataset.pluginCss, 'dsh-gen-limit/card.css');
	});

	it('does nothing at all without a document', () => {
		// The bundle is also evaluated where there is no DOM; the guards are
		// what keep that from throwing during `apply`.
		const harness = loadClient();
		assert.equal(typeof harness.Component, 'function');
		assert.deepEqual(harness.warnings, []);
	});
});
