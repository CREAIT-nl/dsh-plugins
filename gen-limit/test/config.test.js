/**
 * The two pieces of this plugin that hold still: normalising a persisted config
 * into limit rows, and deciding whether a request is allowed to write one.
 * The limiter itself lives inside `apply`'s closure over live harness services
 * and is verified against a running harness instead.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_MAX_QUEUED, DEFAULT_QUEUE_TIMEOUT_MS, DEFAULT_CONFIG, resolveConfig } from '../lib/config.js';
import { CATALOG_ROUTE, CONFIG_ROUTE, STATS_ROUTE, isLoopbackRequest, optionalCount } from '../lib/settings-routes.js';

describe('resolveConfig', () => {
	it('reads a well-formed config through unchanged', () => {
		const limits = [{ provider: 'deepseek', model: 'chat', max: 2 }];
		assert.deepEqual(resolveConfig({ limits }), { limits, queueTimeoutMs: DEFAULT_QUEUE_TIMEOUT_MS, maxQueued: DEFAULT_MAX_QUEUED });
	});

	it('reads the queue knobs when they are set', () => {
		const parsed = resolveConfig({ limits: [], queueTimeoutMs: 5000, maxQueued: 8 });
		assert.equal(parsed.queueTimeoutMs, 5000);
		assert.equal(parsed.maxQueued, 8);
	});

	it('accepts a zero timeout, which means wait without giving up', () => {
		assert.equal(resolveConfig({ queueTimeoutMs: 0 }).queueTimeoutMs, 0);
	});

	it('falls back on an unusable queue setting rather than disabling the wait', () => {
		// A negative or unparseable timeout read as 0 would silently turn every
		// wait unbounded, which is the one setting a typo must not produce.
		for (const bad of [undefined, null, -1, 'soon', Number.NaN]) {
			assert.equal(resolveConfig({ queueTimeoutMs: bad }).queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS);
		}
	});

	it('never lets the queue depth reach zero, which would be refusal by typo', () => {
		// maxQueued 0 admits nobody who cannot start immediately — the old
		// rejecting behaviour, arrived at by accident instead of by choice.
		for (const bad of [0, -5]) assert.equal(resolveConfig({ maxQueued: bad }).maxQueued >= 1, true);
	});

	it('defaults a missing or malformed config to no limits', () => {
		for (const input of [undefined, null, {}, { limits: 'nope' }]) {
			assert.deepEqual(resolveConfig(input), DEFAULT_CONFIG);
		}
	});

	it('treats an unreadable max as unlimited rather than as zero', () => {
		// Zero would deny every generation. -1 is the schema's "no limit", and it
		// is the only safe reading of a row we cannot parse.
		for (const max of [undefined, null, 'two', Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.equal(resolveConfig({ limits: [{ provider: 'p', model: 'm', max }] }).limits[0].max, -1);
		}
	});

	it('rounds a fractional max, since a limit is a count of sessions', () => {
		assert.equal(resolveConfig({ limits: [{ provider: 'p', model: 'm', max: 2.6 }] }).limits[0].max, 3);
	});

	it('coerces missing provider and model to strings rather than dropping the row', () => {
		assert.deepEqual(resolveConfig({ limits: [{ max: 1 }] }).limits, [{ provider: '', model: '', max: 1 }]);
	});
});

describe('the plugin routes', () => {
	it('all sit under one namespaced prefix', () => {
		for (const route of [CONFIG_ROUTE, CATALOG_ROUTE, STATS_ROUTE]) {
			assert.match(route, /^\/api\/dsh-gen-limit\//);
		}
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

describe('optionalCount', () => {
	it('reports absence, so an untouched field is left alone rather than zeroed', () => {
		assert.deepEqual(optionalCount({}, 'maxQueued'), { ok: true });
		assert.deepEqual(optionalCount(undefined, 'maxQueued'), { ok: true });
	});

	it('accepts zero, which is a real setting and not an absent one', () => {
		// queueTimeoutMs: 0 means "wait forever". It has to survive the round trip.
		assert.deepEqual(optionalCount({ queueTimeoutMs: 0 }, 'queueTimeoutMs'), { ok: true, value: 0 });
	});

	it('reads the numeric string a number input actually posts', () => {
		assert.deepEqual(optionalCount({ maxQueued: '32' }, 'maxQueued'), { ok: true, value: 32 });
		assert.deepEqual(optionalCount({ maxQueued: 31.6 }, 'maxQueued'), { ok: true, value: 32 });
	});

	it('rejects a present-but-unusable field instead of coercing it to zero', () => {
		// Every one of these is 0 under `Number()`, and 0 disables the timeout.
		for (const raw of [null, '', false, 'nonsense', NaN, Infinity, -1, {}, []]) {
			assert.deepEqual(optionalCount({ queueTimeoutMs: raw }, 'queueTimeoutMs'), { ok: false }, String(raw));
		}
	});
});
