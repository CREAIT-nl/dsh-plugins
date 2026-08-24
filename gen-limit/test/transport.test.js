/**
 * Which origins get a more patient transport, and what installing one does to
 * the process. The behavioural half — that undici really does stop killing an
 * idle body at five minutes — is a wall-clock experiment and lives in the
 * README's verification note rather than in a suite anyone has to sit through.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getGlobalDispatcher } from 'undici';

import {
	UNDICI_DEFAULT_TIMEOUT_MS,
	WATCHDOG_MARGIN_MS,
	applyTransportTimeouts,
	originOf,
	relaxedOrigins,
} from '../lib/transport.js';

const PATIENT = UNDICI_DEFAULT_TIMEOUT_MS * 6;

describe('originOf', () => {
	it('reduces a base URL to its origin', () => {
		assert.equal(originOf('http://dgx1:7200/v1'), 'http://dgx1:7200');
	});

	it('has no answer for a missing or unparseable base URL', () => {
		for (const input of [undefined, '', '   ', 'not a url', 42]) {
			assert.equal(originOf(input), undefined);
		}
	});
});

describe('relaxedOrigins', () => {
	it('relaxes an origin whose provider asks for more patience than undici has', () => {
		const section = { providers: { dgx: { baseURL: 'http://dgx1:7200/v1', streamIdleTimeoutMs: PATIENT } } };
		assert.deepEqual([...relaxedOrigins(section)], [['http://dgx1:7200', PATIENT + WATCHDOG_MARGIN_MS]]);
	});

	it('leaves alone a provider that declared nothing', () => {
		// The default is only wrong where configuration disagreed with it. A
		// provider that never mentioned the timeout did not disagree.
		const section = { providers: { openrouter: { baseURL: 'https://openrouter.ai/api/v1' } } };
		assert.equal(relaxedOrigins(section).size, 0);
	});

	it('leaves alone a timeout undici already outlasts', () => {
		const section = { providers: { p: { baseURL: 'http://h:1/v1', streamIdleTimeoutMs: 60_000 } } };
		assert.equal(relaxedOrigins(section).size, 0);
	});

	it('ignores a provider it cannot address', () => {
		const section = { providers: { p: { baseURL: 'not a url', streamIdleTimeoutMs: PATIENT } } };
		assert.equal(relaxedOrigins(section).size, 0);
	});

	it('gives a shared origin the most patient of its providers', () => {
		// Two routes through one gateway are one socket pool. The shorter
		// timeout is still enforced per request by the harness watchdog, which
		// this does not touch; the transport only needs to outlast both.
		const section = {
			providers: {
				a: { baseURL: 'http://gw:8080/a', streamIdleTimeoutMs: PATIENT },
				b: { baseURL: 'http://gw:8080/b', streamIdleTimeoutMs: PATIENT * 2 },
			},
		};
		assert.deepEqual([...relaxedOrigins(section)], [['http://gw:8080', PATIENT * 2 + WATCHDOG_MARGIN_MS]]);
	});

	it('normalises a default port away, as the dispatcher does when it matches', () => {
		// undici hands `dispatch` a WHATWG origin, so a base URL that spells out
		// :80 or :443 must reduce to the same key or the route silently misses
		// and the provider keeps the default it was configured out of.
		const spelled = { providers: { p: { baseURL: 'https://api.example.com:443/v1', streamIdleTimeoutMs: PATIENT } } };
		const bare = { providers: { p: { baseURL: 'https://api.example.com/v1', streamIdleTimeoutMs: PATIENT } } };
		assert.deepEqual([...relaxedOrigins(spelled)], [...relaxedOrigins(bare)]);
	});

	it('reads a malformed section as nothing to do', () => {
		for (const section of [undefined, null, {}, { providers: null }, { providers: { p: null } }]) {
			assert.equal(relaxedOrigins(section).size, 0);
		}
	});
});

describe('applyTransportTimeouts', () => {
	it('installs nothing when no provider asked for it', () => {
		const before = getGlobalDispatcher();
		assert.equal(applyTransportTimeouts({ providers: { p: { baseURL: 'http://h:1' } } }), undefined);
		assert.equal(getGlobalDispatcher(), before, 'an untouched process must stay untouched');
	});

	it('installs a dispatcher and puts the previous one back on teardown', () => {
		const before = getGlobalDispatcher();
		const section = { providers: { dgx: { baseURL: 'http://dgx1:7200/v1', streamIdleTimeoutMs: PATIENT } } };
		const teardown = applyTransportTimeouts(section);
		assert.notEqual(getGlobalDispatcher(), before);
		teardown();
		assert.equal(getGlobalDispatcher(), before);
	});

	it('reports what it relaxed', () => {
		const seen = [];
		const teardown = applyTransportTimeouts(
			{ providers: { dgx: { baseURL: 'http://dgx1:7200/v1', streamIdleTimeoutMs: PATIENT } } },
			(origins) => seen.push(...origins),
		);
		teardown();
		assert.deepEqual(seen, [['http://dgx1:7200', PATIENT + WATCHDOG_MARGIN_MS]]);
	});

	it('stands down without clobbering a dispatcher someone else installed after it', () => {
		const before = getGlobalDispatcher();
		const section = { providers: { dgx: { baseURL: 'http://dgx1:7200/v1', streamIdleTimeoutMs: PATIENT } } };
		const teardown = applyTransportTimeouts(section);
		// Somebody else takes over — a proxy, a mock, a second copy of this.
		const later = applyTransportTimeouts(section);
		const other = getGlobalDispatcher();
		teardown();
		assert.equal(getGlobalDispatcher(), other, 'the later dispatcher must survive our teardown');
		later();
	});
});
