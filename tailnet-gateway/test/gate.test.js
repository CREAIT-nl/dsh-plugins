/**
 * The gate, and the header rewriting that follows it.
 *
 * These are the two functions that decide who reaches dsh and what dsh is told
 * about them, so they are the parts worth pinning against a literal table
 * rather than against a running tailnet. The rest of the plugin is a proxy, and
 * `proxy.test.js` drives that end to end over a real socket.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveConfig } from '../lib/config.js';
import { parseStatus, peerAddress, peerLogin } from '../lib/tailnet.js';
import { admit, proxyHeaders } from '../lib/gateway.js';

/** A `tailscale status --json` document trimmed to the fields we read. */
const STATUS = JSON.stringify({
	Self: {
		DNSName: 'harness.example.ts.net.',
		HostName: 'harness',
		TailscaleIPs: ['100.64.0.1'],
		OS: 'linux',
		UserID: 1,
		Online: true,
	},
	Peer: {
		a: {
			DNSName: 'laptop.example.ts.net.',
			HostName: 'laptop',
			TailscaleIPs: ['100.64.0.2', 'fd7a::1'],
			OS: 'macOS',
			UserID: 1,
			Online: true,
		},
		b: {
			DNSName: 'prod-vps.example.ts.net.',
			HostName: 'prod-vps',
			TailscaleIPs: ['100.64.0.3'],
			OS: 'linux',
			UserID: 2,
			Tags: ['tag:prod'],
			Online: true,
		},
	},
	User: {
		1: { LoginName: 'owner@example.com' },
		2: { LoginName: 'tagged-devices' },
	},
});

const table = parseStatus(STATUS);
const base = resolveConfig({});

/** Headers as `tailscale serve` stamps them for a given peer. */
function served(ip, login) {
	return {
		host: 'harness.example.ts.net',
		'x-forwarded-for': ip,
		...(login === undefined ? {} : { 'tailscale-user-login': login }),
	};
}

describe('parseStatus', () => {
	it('names devices by the first DNS label', () => {
		assert.deepEqual(table.devices.map((d) => d.name), ['harness', 'laptop', 'prod-vps']);
	});

	it('maps every address a device holds', () => {
		assert.equal(table.byIp.get('100.64.0.2').name, 'laptop');
		assert.equal(table.byIp.get('fd7a::1').name, 'laptop');
	});

	it('reports the owner of this node, not of the tailnet', () => {
		assert.equal(table.ownerLogin, 'owner@example.com');
	});

	it('marks a tagged node as having no human owner', () => {
		const vps = table.devices.find((d) => d.name === 'prod-vps');
		assert.equal(vps.tagged, true);
		assert.deepEqual(vps.tags, ['tag:prod']);
	});

	it('returns undefined rather than throwing on unusable output', () => {
		assert.equal(parseStatus('tailscaled is not running'), undefined);
		assert.equal(parseStatus('null'), undefined);
	});
});

describe('peerAddress', () => {
	it('reads the first entry, because the last is whatever the client appended', () => {
		assert.equal(peerAddress({ 'x-forwarded-for': '100.64.0.2, 10.0.0.1' }), '100.64.0.2');
	});

	it('drops a port suffix', () => {
		assert.equal(peerAddress({ 'x-forwarded-for': '100.64.0.2:41234' }), '100.64.0.2');
	});

	it('unwraps a bracketed IPv6 literal', () => {
		assert.equal(peerAddress({ 'x-forwarded-for': '[fd7a::1]:41234' }), 'fd7a::1');
	});

	it('is undefined when the header is absent or empty', () => {
		assert.equal(peerAddress({}), undefined);
		assert.equal(peerAddress({ 'x-forwarded-for': '  ' }), undefined);
	});
});

describe('peerLogin', () => {
	it('normalizes case, because an allowlist is compared by value', () => {
		assert.equal(peerLogin({ 'tailscale-user-login': 'Owner@Example.com' }), 'owner@example.com');
	});
});

describe('admit', () => {
	it('lets the node owner in with no allowlist configured', () => {
		const verdict = admit(served('100.64.0.2', 'owner@example.com'), base, table);
		assert.equal(verdict.ok, true);
		assert.equal(verdict.device.name, 'laptop');
	});

	it('refuses a request that carries no Tailscale identity at all', () => {
		// This is the shape of a direct call to the gateway's own port,
		// bypassing `tailscale serve`. It must not be the shape that gets in.
		const verdict = admit({ host: '127.0.0.1:7242' }, base, table);
		assert.equal(verdict.ok, false);
	});

	it('refuses a login that is not the owner', () => {
		assert.equal(admit(served('100.64.0.2', 'someone@else.com'), base, table).ok, false);
	});

	it('refuses a tagged server even though it is on the tailnet', () => {
		assert.equal(admit(served('100.64.0.3', 'tagged-devices'), base, table).ok, false);
	});

	it('honours an explicit login list over the node owner', () => {
		const config = resolveConfig({ allowedLogins: ['Someone@Else.com'] });
		assert.equal(admit(served('100.64.0.2', 'someone@else.com'), config, table).ok, true);
		assert.equal(admit(served('100.64.0.2', 'owner@example.com'), config, table).ok, false);
	});

	it('with the device gate on, admits only listed devices', () => {
		const config = resolveConfig({ deviceAllowlist: true, allowedDevices: ['laptop'] });
		assert.equal(admit(served('100.64.0.2', 'owner@example.com'), config, table).ok, true);
		assert.equal(admit(served('100.64.0.1', 'owner@example.com'), config, table).ok, false);
	});

	it('keeps the device gate closed when the peer table is unreadable', () => {
		// Failing open here would mean a tailscaled restart quietly suspends the
		// allowlist, which is the one moment it most needs to hold.
		const config = resolveConfig({ deviceAllowlist: true, allowedDevices: ['laptop'] });
		assert.equal(admit(served('100.64.0.2', 'owner@example.com'), config, undefined).ok, false);
	});

	it('turning the login gate off still leaves the device gate deciding', () => {
		const config = resolveConfig({ requireLogin: false, deviceAllowlist: true, allowedDevices: ['laptop'] });
		assert.equal(admit(served('100.64.0.2'), config, table).ok, true);
		assert.equal(admit(served('100.64.0.3'), config, table).ok, false);
	});
});

describe('proxyHeaders', () => {
	it('states the loopback hop in host, origin and referer', () => {
		const out = proxyHeaders({
			host: 'harness.example.ts.net',
			origin: 'https://harness.example.ts.net',
			referer: 'https://harness.example.ts.net/settings?tab=models',
			'sec-fetch-site': 'same-origin',
		}, '127.0.0.1:7241');
		assert.equal(out.host, '127.0.0.1:7241');
		assert.equal(out.origin, 'http://127.0.0.1:7241');
		assert.equal(out.referer, 'http://127.0.0.1:7241/settings?tab=models');
	});

	it('leaves sec-fetch-site alone, because that is the browser telling the truth', () => {
		const out = proxyHeaders({ host: 'x', 'sec-fetch-site': 'cross-site' }, '127.0.0.1:7241');
		assert.equal(out['sec-fetch-site'], 'cross-site');
	});

	it('does not invent an origin where the request had none', () => {
		assert.equal('origin' in proxyHeaders({ host: 'x' }, '127.0.0.1:7241'), false);
	});

	it('drops hop-by-hop headers', () => {
		const out = proxyHeaders({ host: 'x', connection: 'keep-alive', 'transfer-encoding': 'chunked' }, '127.0.0.1:7241');
		assert.equal('connection' in out, false);
		assert.equal('transfer-encoding' in out, false);
	});
});

describe('resolveConfig', () => {
	it('refuses to normalize a non-loopback bind host', () => {
		// The gateway hands out loopback trust; on a public interface anyone
		// could forge both headers and take it.
		assert.equal(resolveConfig({ host: '0.0.0.0' }).host, '127.0.0.1');
	});

	it('keeps the device gate off by default', () => {
		// On with an empty list locks out the device that would turn it on.
		assert.equal(base.deviceAllowlist, false);
		assert.equal(base.requireLogin, true);
	});
});
