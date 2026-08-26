/**
 * The wiring between the files, which is the part unit tests kept missing.
 *
 * `settings-routes.js` once imported `peerAddress` from `gateway.js` instead of
 * `tailnet.js`. Every unit test passed — they import the helpers from the
 * module that really exports them — and dsh refused to boot. So this file
 * imports the plugin the way the loader does, and pins the route shape the
 * webserver contract requires.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as plugin from '../lib/index.js';
import { resolveConfig } from '../lib/config.js';
import { CONFIG_ROUTE, DEVICES_ROUTE, isLoopbackRequest, makeSettingsRoutes } from '../lib/settings-routes.js';

describe('module graph', () => {
	it('imports as the loader imports it', () => {
		assert.equal(plugin.name, 'tailnet-gateway');
		assert.equal(typeof plugin.apply, 'function');
		assert.equal(plugin.TAILNET_SETTINGS_NAMESPACE, 'dsh-tailnet-gateway');
	});
});

describe('routes', () => {
	const routes = makeSettingsRoutes({ get: () => undefined }, resolveConfig, { get: async () => undefined }, () => ({}));

	it('is a list of single routes, because register() takes one at a time', () => {
		// Handing the whole family to register() makes one malformed route and
		// every path 404s silently: no boot error, no log line.
		assert.deepEqual(routes.map((route) => route.path), [CONFIG_ROUTE, DEVICES_ROUTE]);
		for (const route of routes) {
			assert.equal(route.kind, 'exact');
			assert.equal(typeof route.handler, 'function');
		}
	});
});

describe('isLoopbackRequest', () => {
	/** A request as it reaches a plugin route on the dsh webserver. */
	const request = (address, headers) => ({ socket: { remoteAddress: address }, headers });

	it('admits the gateway, which reaches dsh over loopback', () => {
		assert.equal(isLoopbackRequest(request('127.0.0.1', { host: '127.0.0.1:7241' })), true);
	});

	it('refuses a caller that is not on loopback', () => {
		assert.equal(isLoopbackRequest(request('192.168.1.20', { host: '127.0.0.1:7241' })), false);
	});

	it('refuses a loopback caller carrying someone else Host header', () => {
		assert.equal(isLoopbackRequest(request('127.0.0.1', { host: 'harness.example.ts.net' })), false);
	});

	it('refuses a cross-site fetch and a mismatched origin', () => {
		assert.equal(isLoopbackRequest(request('127.0.0.1', { host: '127.0.0.1:7241', 'sec-fetch-site': 'cross-site' })), false);
		assert.equal(isLoopbackRequest(request('127.0.0.1', { host: '127.0.0.1:7241', origin: 'http://evil.example' })), false);
	});
});
