/**
 * The Settings page, driven without a browser.
 *
 * The page is a form, and a browser proved the form renders. What a browser
 * cannot easily do is hand it a *report* — and the reports are the reason this
 * plugin is debuggable at all. Every silent-failure hunt in its history came
 * down to the same thing: the reason never reached a surface anyone reads. So
 * the report-rendering rules get the weight here. A run that found no Chinese
 * and a run that failed on every file are the same shape of result and used to
 * render as the same sentence; keeping them distinguishable is a test, not a
 * comment.
 *
 * Everything runs against the shipped `client/client.cjs`, loaded the way the
 * shell loads it, and the control tests run it twice: once with the primitives
 * seed module present, which is what every browser sees, and once without,
 * which is the degraded path the wrappers promise.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	CATALOG_ROUTE,
	CONFIG_ROUTE,
	STATUS_ROUTE,
	TRANSLATE_ROUTE,
	buttonsOf,
	loadClient,
	makeDom,
	makeNavCell,
	packageInput,
	promptBox,
	propsFor,
	renderChild,
	selectorsOf,
	settle,
	togglesOf,
	walk,
} from './client-harness.js';

const CATALOG = {
	providers: [{ id: 'dgx', name: 'DGX' }, { id: 'cloud', name: 'Cloud' }],
	models: { dgx: [{ id: 'v4-flash', name: 'V4 Flash' }], cloud: [{ id: 'v4', name: 'V4' }] },
};

const config = (value, writable = true) => ({ body: { writable, value } });

/**
 * Mount the page with its three reads already answered.
 *
 * The registered component is `ToEnglishSection`, a one-line wrapper that
 * returns a `ToEnglishCard` element; the state and the fetches all live in the
 * card. So the section is mounted first — that is the component the shell
 * mounts, and rendering it is the only thing that proves the wrapper forwards
 * its props, `t` included — and the card it returns is then mounted in turn.
 */
async function open(options = {}) {
	const harness = loadClient({ catalog: { body: CATALOG }, config: config({}), ...options });
	const section = harness.mount(harness.Component, propsFor());
	const instance = harness.mount(section.output.type, section.output.props);
	await settle();
	await settle();
	return { ...harness, section, instance };
}

/** Every POST the page has sent to a given route, in order. */
const postsTo = (harness, route) => harness.requests.filter((r) => r.method === 'POST' && r.url === route).map((r) => r.body);

/** The `te-status` lines currently on the page. */
const statusLines = (instance) => walk(instance.output)
	.filter((n) => typeof n.props?.className === 'string' && n.props.className.split(' ').includes('te-status'))
	.map((n) => n.children.filter((c) => typeof c === 'string').join(''));

describe('registration', () => {
	it('registers under the full package name, which is what the loader looks up', () => {
		// A short id here is the "loaded without registering" failure: the
		// loader checks `factories.has(row.id)` against the package name.
		assert.equal(loadClient().id, '@creait/dsh-to-english');
	});

	it('asks for exactly the services it uses, and not the seed module', () => {
		// The primitives module is resolved by the shell like `react`. Naming
		// it in `inject` would make the loader demand a row that does not
		// exist, and the plugin would never mount.
		assert.deepEqual([...loadClient().inject], ['slots', 'locale']);
	});

	it('registers a top-level settings nav entry, not a plugin card', () => {
		const { descriptor } = loadClient();
		assert.equal(descriptor.name, 'settings.section');
		assert.equal(descriptor.id, 'dsh-to-english');
		assert.equal(descriptor.locale, 'dsh-to-english');
		assert.equal(typeof descriptor.label, 'function');
	});

	it('still mounts the page when the locale is already registered', () => {
		// A client reload re-registers the namespace and `register` throws;
		// sharing one `try` with the slot registration would turn that into a
		// missing Settings page.
		const harness = loadClient({ locale: 'throws' });
		assert.equal(typeof harness.Component, 'function');
		assert.equal(harness.descriptor.name, 'settings.section');
		assert.ok(harness.warnings.some((w) => w.includes('locale unavailable')));
	});
});

describe('reading the deployment', () => {
	it('reads config, catalog and status on mount', async () => {
		const { requests } = await open();
		assert.deepEqual(new Set(requests.filter((r) => r.method === 'GET').map((r) => r.url)), new Set([CONFIG_ROUTE, CATALOG_ROUTE, STATUS_ROUTE]));
	});

	it('treats an absent flag as on, so a fresh install translates', async () => {
		// `enabled !== false` and `translateEverything !== false`: a config
		// that has never been written must not read as "everything off".
		const { instance } = await open({ config: config({}) });
		const toggles = togglesOf(instance);
		assert.equal(toggles.enabledLabel.props['aria-checked'], 'true');
		assert.equal(toggles.blindLabel.props['aria-checked'], 'true');
	});

	it('honours a flag that was written off', async () => {
		const { instance } = await open({ config: config({ enabled: false, translateEverything: false }) });
		const toggles = togglesOf(instance);
		assert.equal(toggles.enabledLabel.props['aria-checked'], 'false');
		assert.equal(toggles.blindLabel.props['aria-checked'], 'false');
	});

	it('defaults the rewrite margin to 1 when the stored value is not a number', async () => {
		const { instance } = await open({ config: config({ rewriteRadius: 'wide' }) });
		assert.equal(selectorsOf(instance)[2].props.value, '1');
	});

	it('says so, and locks every control, when the deployment is read-only', async () => {
		const { instance } = await open({ config: config({}, false) });
		assert.ok(statusLines(instance).includes('readOnly'));
		for (const node of selectorsOf(instance)) assert.equal(node.props.disabled, true);
		for (const node of Object.values(togglesOf(instance))) assert.equal(node.props.disabled, true);
		assert.equal(promptBox(instance).props.disabled, true);
	});

	it('renders even when nothing answers', async () => {
		// `loadJson` swallows a failed read and keeps its fallback; the page
		// must still draw rather than blanking the Settings panel.
		const { instance, warnings } = await open({ config: 'network', catalog: 'network', status: 'network' });
		assert.ok(walk(instance.output).length > 0);
		assert.equal(warnings.some((w) => w.includes('failed') || w.includes('error')), false, 'a dead route is handled, not reported as a crash');
	});

	it('explains an empty catalog rather than showing an empty dropdown', async () => {
		const { instance } = await open({ catalog: { body: { providers: [], models: {} } } });
		const descs = walk(instance.output).filter((n) => n.props?.className === 'te-desc').map((n) => n.children.join(''));
		assert.ok(descs.includes('catalogEmpty'));
	});
});

describe('editing the settings', () => {
	it('offers nothing to save until something changes', async () => {
		// A filled primary capsule greys out whole when disabled, so the page
		// renders status text instead of a dead button.
		const { instance } = await open();
		assert.ok(statusLines(instance).includes('saved'));
		assert.equal(buttonsOf(instance).some((b) => b.props.variant === 'primary' && b.children.includes('save')), false);
	});

	it('writes the whole draft once the form is dirty', async () => {
		const harness = await open({ config: config({ prompt: 'old' }) });
		promptBox(harness.instance).props.onChange({ target: { value: 'new' } });
		const save = buttonsOf(harness.instance).find((b) => b.children.includes('save'));
		assert.ok(save, 'a dirty form must offer a save button');
		save.props.onClick();
		await settle();
		assert.equal(postsTo(harness, CONFIG_ROUTE)[0].prompt, 'new');
	});

	it('goes back to clean after a successful write', async () => {
		const harness = await open({ config: config({ prompt: 'old' }) });
		promptBox(harness.instance).props.onChange({ target: { value: 'new' } });
		buttonsOf(harness.instance).find((b) => b.children.includes('save')).props.onClick();
		await settle();
		await settle();
		assert.ok(statusLines(harness.instance).includes('saved'));
	});

	it('keeps the save button when the write fails, so the edit is not lost', async () => {
		const harness = await open({ config: config({ prompt: 'old' }), post: { status: 500 } });
		promptBox(harness.instance).props.onChange({ target: { value: 'new' } });
		buttonsOf(harness.instance).find((b) => b.children.includes('save')).props.onClick();
		await settle();
		await settle();
		const save = buttonsOf(harness.instance).find((b) => b.children.includes('save'));
		assert.ok(save, 'the form stays dirty');
		assert.equal(save.props.disabled, false, 'and the button is clickable again');
	});

	it('clears the model when the provider changes, so a mismatched pair cannot be written', async () => {
		const harness = await open({ config: config({ provider: 'dgx', model: 'v4-flash' }) });
		selectorsOf(harness.instance)[0].props.onChange('cloud');
		await settle();
		assert.equal(selectorsOf(harness.instance)[1].props.value, '');
		assert.deepEqual(selectorsOf(harness.instance)[1].props.options.map((o) => o.id), ['v4']);
	});

	it('leaves the model dropdown disabled until a provider is picked', async () => {
		const { instance } = await open({ config: config({}) });
		assert.equal(selectorsOf(instance)[1].props.disabled, true);
	});

	it('clamps the rewrite margin to the range the gate understands', async () => {
		const harness = await open({ config: config({ rewriteRadius: 1 }) });
		const radius = () => selectorsOf(harness.instance)[2];
		radius().props.onChange('9');
		await settle();
		assert.equal(radius().props.value, '5');
		radius().props.onChange('-3');
		await settle();
		assert.equal(radius().props.value, '0');
		radius().props.onChange('nonsense');
		await settle();
		assert.equal(radius().props.value, '1');
	});
});

describe('a manual run', () => {
	it('does nothing without a package name', async () => {
		// The button is enabled so it does not sit greyed out, so the guard
		// has to be in the handler.
		const harness = await open();
		buttonsOf(harness.instance).find((b) => b.children.includes('translate')).props.onClick();
		await settle();
		assert.deepEqual(postsTo(harness, TRANSLATE_ROUTE), []);
	});

	it('does nothing for a name that is only spaces', async () => {
		const harness = await open();
		packageInput(harness.instance).props.onChange({ target: { value: '   ' } });
		buttonsOf(harness.instance).find((b) => b.children.includes('translate')).props.onClick();
		await settle();
		assert.deepEqual(postsTo(harness, TRANSLATE_ROUTE), []);
	});

	it('posts the trimmed name and re-reads the status afterwards', async () => {
		const harness = await open();
		packageInput(harness.instance).props.onChange({ target: { value: '  dsh-enhance  ' } });
		buttonsOf(harness.instance).find((b) => b.children.includes('translate')).props.onClick();
		await settle();
		await settle();
		await settle();
		assert.deepEqual(postsTo(harness, TRANSLATE_ROUTE), [{ packageName: 'dsh-enhance' }]);
		assert.equal(harness.requests.filter((r) => r.url === STATUS_ROUTE).length, 2, 'the run changed the status, so it is read again');
	});

	it('will not start a second run while one is in flight', async () => {
		const harness = await open();
		packageInput(harness.instance).props.onChange({ target: { value: 'dsh-enhance' } });
		const button = () => buttonsOf(harness.instance).find((b) => b.children.includes('translate') || b.children.includes('translating'));
		button().props.onClick();
		assert.ok(button().children.includes('translating'), 'the button reports the run');
		assert.equal(button().props.disabled, true);
		button().props.onClick();
		await settle();
		await settle();
		assert.equal(postsTo(harness, TRANSLATE_ROUTE).length, 1);
	});

	it('reports a rejected request rather than looking like it never ran', async () => {
		const harness = await open({ translate: 'network' });
		packageInput(harness.instance).props.onChange({ target: { value: 'dsh-enhance' } });
		buttonsOf(harness.instance).find((b) => b.children.includes('translate')).props.onClick();
		await settle();
		await settle();
		assert.ok(statusLines(harness.instance).some((line) => line.includes('offline')));
	});
});

describe('reporting what a run did', () => {
	/** Run once against a scripted report and read the lines it produced. */
	async function report(body) {
		const harness = await open({ translate: { body } });
		packageInput(harness.instance).props.onChange({ target: { value: 'pkg' } });
		buttonsOf(harness.instance).find((b) => b.children.includes('translate')).props.onClick();
		await settle();
		await settle();
		await settle();
		return { harness, lines: statusLines(harness.instance) };
	}

	it('says "no Chinese" only when there was genuinely nothing to do', async () => {
		const { lines } = await report({ status: 'done', translated: [], errors: [] });
		assert.ok(lines.includes('resultNoCjk'));
	});

	it('does NOT say "no Chinese" when every file failed', async () => {
		// This is the bug the report rules exist for: zero files translated
		// looked identical whether nothing needed translating or everything
		// broke, and the second case reads as success.
		const { lines } = await report({
			status: 'done',
			translated: [],
			errors: [{ file: 'lib/index.js', status: 'invalid', message: 'did not parse' }],
		});
		assert.equal(lines.includes('resultNoCjk'), false);
		assert.ok(lines.some((line) => line.includes('resultFailed')));
	});

	it('quotes the first failure verbatim, and flags it to assistive tech', async () => {
		const { harness } = await report({
			status: 'done',
			translated: ['a.js'],
			errors: [{ file: 'lib/index.js', status: 'invalid', message: 'did not parse' }],
		});
		const alert = walk(harness.instance.output).find((n) => n.props?.role === 'alert');
		assert.ok(alert, 'the reason needs a surface someone reads');
		assert.equal(alert.children.join(''), 'lib/index.js: invalid — did not parse');
	});

	it('reports the Chinese it could not reach', async () => {
		// A partial pass is not a pass; the count of what is left is the only
		// thing that says so.
		const { lines } = await report({ status: 'done', translated: ['a.js'], errors: [], cjkRemaining: 12 });
		assert.ok(lines.some((line) => line.includes('12 resultCjkLeft')));
	});

	it('reports the reload the run needed', async () => {
		const { lines } = await report({ status: 'done', translated: ['a.js'], errors: [], reload: 'restart' });
		assert.ok(lines.some((line) => line.includes('reload=restart')));
	});

	it('distinguishes the three ways a run declines to start', async () => {
		for (const [status, label] of [['disabled', 'resultDisabled'], ['no-model', 'resultNoModel'], ['no-llm', 'resultNoLlm']]) {
			const { lines } = await report({ status });
			assert.ok(lines.includes(label), `${status} must render as ${label}`);
		}
	});

	it('falls back to the raw status rather than rendering nothing', async () => {
		const { lines } = await report({ status: 'something-new' });
		assert.ok(lines.includes('something-new'));
	});

	it('shows the last run and the one in flight from the host status', async () => {
		const { instance } = await open({
			status: { body: { lastRun: { packageName: 'dsh-enhance', report: { status: 'done', translated: ['a.js'], errors: [] } }, running: { packageName: 'dsh-recall', done: 3, total: 9, file: 'lib/x.js' } } },
		});
		const lines = statusLines(instance);
		assert.ok(lines.some((line) => line.startsWith('lastRun: dsh-enhance ·')));
		assert.ok(lines.some((line) => line.includes('dsh-recall 3/9 lib/x.js')));
	});

	it('says so when nothing has run yet', async () => {
		const { instance } = await open({ status: { body: null } });
		assert.ok(statusLines(instance).includes('lastRun: never'));
	});
});

describe('the primitives path', () => {
	/** The props the bundle handed `P.Menu` for the nth Selector on the page. */
	const menuOf = (harness, index) => renderChild(harness, selectorsOf(harness.instance)[index]).output.props;

	it('renders a Menu, not a native select, for a dropdown', async () => {
		const harness = await open({ primitives: true });
		assert.equal(renderChild(harness, selectorsOf(harness.instance)[0]).output.type, harness.primitives.Menu);
	});

	it('portals the menu, so it is not clipped inside the settings panel', async () => {
		const harness = await open({ primitives: true });
		assert.equal(menuOf(harness, 0).portal, true);
	});

	it('offers the catalog as menu items and marks the current one', async () => {
		const harness = await open({ primitives: true, config: config({ provider: 'dgx' }) });
		const menu = menuOf(harness, 0);
		assert.deepEqual(menu.items.map((item) => ({ id: item.id, label: item.label })), [{ id: 'dgx', label: 'DGX' }, { id: 'cloud', label: 'Cloud' }]);
		assert.equal(menu.selectedId, 'dgx');
	});

	it('closes on select and reports only a real change', async () => {
		const picked = [];
		const harness = await open({ primitives: true, config: config({ provider: 'dgx' }) });
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

	it('draws the package box and the buttons from the seed module', async () => {
		const harness = await open({ primitives: true });
		assert.equal(packageInput(harness.instance).type, harness.primitives.Input);
		const translate = buttonsOf(harness.instance).find((b) => b.children.includes('translate'));
		assert.equal(renderChild(harness, translate).output.type, harness.primitives.Button);
	});

	it('falls back to plain controls, and says why, when the seed module is absent', async () => {
		const harness = await open();
		assert.equal(renderChild(harness, selectorsOf(harness.instance)[0]).output.type, 'select');
		assert.equal(packageInput(harness.instance).type, 'input');
		assert.equal(renderChild(harness, buttonsOf(harness.instance)[0]).output.type, 'button');
		assert.ok(harness.warnings.some((w) => w.includes('ui primitives unavailable')));
	});
});

describe('the nav glyph', () => {
	it('replaces the whole child list, because the gear paths would draw through ours', () => {
		// Six paths against the gear's two: retouching path by path leaves the
		// gear's own geometry behind, which is exactly the bug that made the
		// first version of this look like a smudge.
		const cell = makeNavCell('To English');
		loadClient({ dom: makeDom([cell]) });
		assert.equal(cell.svg.innerHTML.includes('gear-ring'), false);
		assert.equal(cell.svg.innerHTML.includes('gear-dot'), false);
		assert.ok(cell.svg.innerHTML.startsWith('<path d="M10.8239 3.54733'));
		assert.equal(cell.svg.attrs.viewBox, '0 0 16 16', 'the new glyph is drawn on its own grid');
		assert.equal(cell.svg.dataset.teNavicon, '1');
	});

	it('matches the row in either locale', () => {
		const cell = makeNavCell('转英文');
		loadClient({ dom: makeDom([cell]) });
		assert.equal(cell.svg.dataset.teNavicon, '1');
	});

	it('leaves every other settings row alone', () => {
		const other = makeNavCell('Plugins');
		loadClient({ dom: makeDom([other]) });
		assert.equal(other.svg.innerHTML.includes('gear-ring'), true);
		assert.equal(other.svg.dataset.teNavicon, undefined);
	});

	it('is idempotent, so a re-render does not re-walk a painted row', () => {
		const cell = makeNavCell('To English');
		const dom = makeDom([cell]);
		loadClient({ dom });
		cell.svg.innerHTML = 'sentinel';
		dom.mutate();
		assert.equal(cell.svg.innerHTML, 'sentinel', 'a flagged row is skipped');
	});

	it('repaints a gear that came back, which is what a panel remount draws', () => {
		const dom = makeDom([makeNavCell('To English')]);
		loadClient({ dom });
		const fresh = makeNavCell('To English');
		dom.cells.length = 0;
		dom.cells.push(fresh);
		dom.mutate();
		assert.equal(fresh.svg.dataset.teNavicon, '1');
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
	});

	it('does nothing at all without a document', () => {
		// The bundle is also evaluated where there is no DOM; the guards are
		// what keep that from throwing during `apply`.
		const harness = loadClient();
		assert.equal(typeof harness.Component, 'function');
		assert.equal(harness.warnings.some((w) => w.includes('nav icon swap unavailable')), false);
	});
});
