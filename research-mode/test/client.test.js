/**
 * The width pill's behaviour, driven through real hook semantics.
 *
 * These cover the cases a browser cannot reach. A live page proves the control
 * renders and that a write reaches the settings store — both verified there —
 * but it cannot unmount the component mid-debounce, cannot fail a GET four
 * times, and cannot show that a rejected write was reported anywhere. Each of
 * those is a promise this control now makes, so each gets a test.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadClient, propsFor } from './client-harness.js';

/** Let every queued microtask settle, which is where the fetch chains live. */
const settle = () => new Promise((resolve) => { setImmediate(resolve); });

const view = (width, extra = {}) => ({ status: 'ready', value: { width }, writable: true, revision: 1, ...extra });

/** The rendered `input`, or undefined when the control declined to render. */
function inputOf(instance) {
	const node = instance.output;
	if (node === null || node === undefined) return undefined;
	return node.children.find((child) => child.props?.className === 'rw-input')?.props;
}

const pillOf = (instance) => instance.output?.props;

describe('the width pill: registration', () => {
	it('registers under the full package name, which is what the loader looks up', () => {
		// A short id loads without error and then fails the loader's
		// `factories.has(row.id)` check — "loaded without registering".
		assert.equal(loadClient().id, '@creait/dsh-research-mode');
	});

	it('declares exactly the services it uses', () => {
		// Copied first: the bundle is evaluated in its own realm, so its array
		// literal has that realm's prototype and would fail a strict deep-equal
		// for a reason that has nothing to do with the contents.
		assert.deepEqual([...loadClient().inject], ['slots', 'locale']);
	});

	it('registers both locales, so the hint is never a bare key', () => {
		const { locales } = loadClient();
		assert.deepEqual(Object.keys(locales[0].bundles).sort(), ['en', 'zh']);
		for (const bundle of Object.values(locales[0].bundles)) {
			assert.deepEqual(Object.keys(bundle).sort(), ['auto', 'hint', 'label', 'offline', 'readOnly', 'title']);
		}
	});
});

describe('the width pill: outside its own preset', () => {
	it('renders nothing and asks for nothing', async () => {
		const client = loadClient();
		const instance = client.mount(client.Component, propsFor({ preset: 'default' }));
		await settle();
		assert.equal(instance.output, null);
		// The claim the roster half makes is that other sessions pay nothing for
		// this package. A speculative GET here would quietly break it.
		assert.deepEqual(client.requests, []);
	});

	it('starts loading only once the session turns out to be a research one', async () => {
		const client = loadClient({ responses: [{ body: view(3) }] });
		const instance = client.mount(client.Component, propsFor({ preset: 'default' }));
		await settle();
		assert.equal(client.requests.length, 0);
		instance.setProps({ useSessions: (selector) => selector({ byId: { s1: { agentPreset: 'research' } } }) });
		await settle();
		assert.equal(client.requests.length, 1);
		assert.equal(inputOf(instance).value, '3');
	});
});

describe('the width pill: reading the stored pin', () => {
	it('shows the pinned width and marks itself pinned', async () => {
		const client = loadClient({ responses: [{ body: view(5) }] });
		const instance = client.mount(client.Component, propsFor());
		await settle();
		assert.equal(client.requests[0].method, 'GET');
		assert.equal(inputOf(instance).value, '5');
		assert.equal(pillOf(instance)['data-pinned'], '1');
	});

	it('shows an empty field for the auto sentinel', async () => {
		const client = loadClient({ responses: [{ body: view(0) }] });
		const instance = client.mount(client.Component, propsFor());
		await settle();
		assert.equal(inputOf(instance).value, '');
		assert.equal(pillOf(instance)['data-pinned'], '0');
		assert.equal(inputOf(instance).placeholder, 'auto');
	});

	it('formats only — a width the server normalized is shown as it was sent', async () => {
		// The rounding lives in the route now. Were the client to re-derive it,
		// this would be the test that stopped failing when the two disagreed.
		const client = loadClient({ responses: [{ body: view(4) }] });
		const instance = client.mount(client.Component, propsFor());
		await settle();
		assert.equal(inputOf(instance).value, '4');
	});

	it('disables itself against a read-only store', async () => {
		const client = loadClient({ responses: [{ body: view(3, { writable: false }) }] });
		const instance = client.mount(client.Component, propsFor());
		await settle();
		assert.equal(inputOf(instance).disabled, true);
		assert.equal(pillOf(instance).title, 'readOnly');
	});
});

describe('the width pill: a load that fails', () => {
	it('retries, and settles as soon as one attempt answers', async () => {
		const client = loadClient({ responses: ['network', { body: view(6) }] });
		const instance = client.mount(client.Component, propsFor());
		await settle();
		assert.equal(inputOf(instance).value, '');
		client.clock.tick(1200);
		await settle();
		assert.equal(client.requests.length, 2);
		assert.equal(inputOf(instance).value, '6');
	});

	it('gives up disabled rather than claiming no pin is set', async () => {
		// An empty ENABLED field asserts "auto" — that the stored width is
		// unpinned. After four failures the control does not know that, and the
		// one thing it must not do is guess.
		const client = loadClient({ responses: ['network', 'network', 'network', 'network'] });
		const instance = client.mount(client.Component, propsFor());
		await settle();
		for (let attempt = 0; attempt < 3; attempt += 1) { client.clock.tick(1200); await settle(); }
		assert.equal(client.requests.length, 4);
		assert.equal(inputOf(instance).disabled, true);
		assert.equal(pillOf(instance).title, 'offline');
		// And it stops: no timer is left armed to poll a route that keeps refusing.
		assert.equal(client.clock.pending, 0);
	});

	it('reports the status, so a 403 from the loopback guard is findable', async () => {
		const client = loadClient({ responses: [{ status: 403, body: { error: 'forbidden: loopback-only' } }, { body: view(2) }] });
		const instance = client.mount(client.Component, propsFor());
		await settle();
		assert.match(client.warnings[0], /403/);
		assert.match(client.warnings[0], /loopback-only/);
		client.clock.tick(1200);
		await settle();
		assert.equal(inputOf(instance).value, '2');
	});
});

describe('the width pill: writing', () => {
	/** Mount, load `width`, and hand back the change handler. */
	async function loaded(width, responses = []) {
		const client = loadClient({ responses: [{ body: view(width) }, ...responses] });
		const instance = client.mount(client.Component, propsFor());
		await settle();
		return { client, instance, type: (value) => inputOf(instance).onChange({ target: { value } }) };
	}

	it('debounces, so holding an arrow key is one request', async () => {
		const { client, type } = await loaded(1, [{ body: view(4) }]);
		type('2');
		type('3');
		type('4');
		assert.equal(client.requests.length, 1, 'nothing written before the debounce elapses');
		client.clock.tick(400);
		await settle();
		assert.equal(client.requests.length, 2);
		assert.deepEqual(client.requests[1].body, { width: 4 });
	});

	it('writes the auto sentinel when the field is cleared', async () => {
		const { client, type } = await loaded(3, [{ body: view(0) }]);
		type('');
		client.clock.tick(400);
		await settle();
		assert.deepEqual(client.requests[1].body, { width: 0 });
	});

	it('clamps to the field ceiling before it writes', async () => {
		const { client, type } = await loaded(3, [{ body: view(8) }]);
		type('99');
		client.clock.tick(400);
		await settle();
		assert.deepEqual(client.requests[1].body, { width: 8 });
	});

	it('flushes a pending write on unmount instead of dropping it', async () => {
		// Leaving the composer within the debounce used to discard the
		// keystroke — the control ignoring you at the moment you finished typing.
		const { client, instance, type } = await loaded(3, [{ body: view(6) }]);
		type('6');
		assert.equal(client.requests.length, 1);
		instance.unmount();
		await settle();
		assert.equal(client.requests.length, 2);
		assert.deepEqual(client.requests[1].body, { width: 6 });
	});

	it('unmounts cleanly when nothing is pending', async () => {
		const { client, instance } = await loaded(3);
		instance.unmount();
		await settle();
		assert.equal(client.requests.length, 1);
	});

	it('reports a rejected write rather than looking like it applied', async () => {
		const { client, type } = await loaded(3, [{ status: 409, body: { error: 'write failed: stale revision' } }]);
		type('5');
		client.clock.tick(400);
		await settle();
		assert.match(client.warnings[0], /409/);
		assert.match(client.warnings[0], /stale revision/);
	});

	it('disables itself when the write path reports the store went read-only', async () => {
		const { client, instance, type } = await loaded(3, [{ body: view(5, { writable: false }) }]);
		type('5');
		client.clock.tick(400);
		await settle();
		assert.equal(inputOf(instance).disabled, true);
	});

	it('ignores a response that lands after unmount', async () => {
		const { client, instance, type } = await loaded(3, [{ body: view(5, { writable: false }) }]);
		type('5');
		instance.unmount();
		await settle();
		// The write landed; the state it would have set did not, because there is
		// no longer a component to hold it.
		assert.equal(client.requests.length, 2);
		assert.equal(inputOf(instance).disabled, false);
	});
});
