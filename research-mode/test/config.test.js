/**
 * The two pieces of the roster half that hold still: coercing a stored or posted
 * width into the canonical form, and deciding whether a request is allowed to
 * write one. The route handler itself closes over live harness services and is
 * verified against a running harness instead.
 *
 * `isLoopbackRequest` is a deliberate copy of @creait/dsh-gen-limit's guard —
 * the two packages publish independently and neither should depend on the other
 * for the one function that keeps a settings write off the network. A copy needs
 * its own coverage, because a fix to one is invisible to the other.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { RESEARCH_SETTINGS_NAMESPACE, WIDTH_AUTO, normalizeWidth, pinnedWidth } from '../lib/config.js';
import { CONFIG_ROUTE, isLoopbackRequest, viewOf } from '../lib/settings-routes.js';

describe('normalizeWidth', () => {
	it('passes a positive integer through unchanged', () => {
		for (const width of [1, 3, 8, 100]) assert.equal(normalizeWidth(width), width);
	});

	it('rounds a fractional width, so the field and the run agree', () => {
		assert.equal(normalizeWidth(3.7), 4);
		assert.equal(normalizeWidth('2.2'), 2);
	});

	it('reads a numeric string, which is what the wire carries', () => {
		assert.equal(normalizeWidth('5'), 5);
	});

	it('collapses anything unusable to auto rather than guessing', () => {
		for (const input of [undefined, null, '', 'nope', NaN, Infinity, -1, 0, 0.4, {}, []]) {
			assert.equal(normalizeWidth(input), WIDTH_AUTO);
		}
	});
});

describe('pinnedWidth', () => {
	it('reports no pin for auto, so the model argument stands', () => {
		for (const input of [undefined, {}, { width: 0 }, { width: 'nope' }]) {
			assert.equal(pinnedWidth(input), undefined);
		}
	});

	it('reports the pin for any width the user actually set', () => {
		assert.equal(pinnedWidth({ width: 3 }), 3);
		assert.equal(pinnedWidth({ width: '6' }), 6);
	});
});

describe('the plugin route', () => {
	it('sits under the package-namespaced prefix', () => {
		assert.match(CONFIG_ROUTE, /^\/api\/dsh-research-mode\//);
	});
});

describe('isLoopbackRequest', () => {
	const request = (overrides = {}) => ({
		socket: { remoteAddress: '127.0.0.1' },
		headers: { host: '127.0.0.1:3080' },
		...overrides,
	});

	it('admits a same-origin request from loopback', () => {
		assert.equal(isLoopbackRequest(request()), true);
	});

	it('admits the IPv6 and IPv4-mapped loopback forms', () => {
		for (const remoteAddress of ['::1', '::ffff:127.0.0.1']) {
			assert.equal(isLoopbackRequest(request({ socket: { remoteAddress } })), true);
		}
	});

	it('refuses a request from off-box, whatever the Host header claims', () => {
		assert.equal(isLoopbackRequest(request({ socket: { remoteAddress: '10.0.0.7' } })), false);
	});

	it('refuses a loopback connection carrying a non-loopback Host', () => {
		assert.equal(isLoopbackRequest(request({ headers: { host: 'evil.example' } })), false);
	});

	it('refuses a request with no Host header to compare against', () => {
		assert.equal(isLoopbackRequest(request({ headers: {} })), false);
	});

	it('refuses a cross-site fetch, which is the shape a DNS-rebind write takes', () => {
		const headers = { host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' };
		assert.equal(isLoopbackRequest(request({ headers })), false);
	});

	it('refuses a foreign Origin and admits a matching one', () => {
		const with_ = (origin) => request({ headers: { host: '127.0.0.1:3080', origin } });
		assert.equal(isLoopbackRequest(with_('http://evil.example')), false);
		assert.equal(isLoopbackRequest(with_('http://127.0.0.1:3080')), true);
		assert.equal(isLoopbackRequest(with_('not a url')), false);
	});
});

describe('viewOf', () => {
	const ctxWith = (settings) => ({ get: (name) => (name === 'settings' ? settings : undefined) });
	const service = (descriptor, writable = true) => ({
		writable,
		describe: () => (descriptor === undefined ? [] : [{ ns: RESEARCH_SETTINGS_NAMESPACE, ...descriptor }]),
	});

	it('reports unavailable when the settings service is absent', () => {
		assert.deepEqual(viewOf({ get: () => undefined }), { status: 'unavailable', writable: false });
	});

	it('reports unavailable, but keeps writable, when the namespace is unregistered', () => {
		assert.deepEqual(viewOf(ctxWith(service(undefined))), { status: 'unavailable', writable: true });
	});

	it('normalizes the served width, so the field cannot show a value the tool will not run', () => {
		// The browser formats this and nothing else. Were the raw 3.7 served, the
		// field would read 3.7 while `buildArgs` rounded it to 4.
		const view = viewOf(ctxWith(service({ value: { width: 3.7 }, revision: 2 })));
		assert.equal(view.value.width, 4);
		assert.equal(view.revision, 2);
	});

	it('serves the auto sentinel for an unusable stored width', () => {
		for (const stored of [undefined, 0, -1, 'nonsense']) {
			assert.equal(viewOf(ctxWith(service({ value: { width: stored } }))).value.width, WIDTH_AUTO);
		}
	});

	it('passes the base and user layers through untouched, since the write path compares them', () => {
		const view = viewOf(ctxWith(service({ value: { width: 3 }, base: { width: 3 }, user: { width: 3 } })));
		assert.deepEqual(view.base, { width: 3 });
		assert.deepEqual(view.user, { width: 3 });
	});

	it('omits layers that do not exist rather than sending explicit undefined', () => {
		const view = viewOf(ctxWith(service({ value: { width: 0 } })));
		assert.equal('base' in view, false);
		assert.equal('user' in view, false);
	});

	it('reports a read-only store, which is what disables the control', () => {
		assert.equal(viewOf(ctxWith(service({ value: { width: 2 } }, false))).writable, false);
	});
});
