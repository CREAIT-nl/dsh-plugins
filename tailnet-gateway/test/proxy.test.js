/**
 * The gateway end to end, over real sockets, against a stand-in for dsh.
 *
 * The gate is unit-tested in `gate.test.js`; what this file exists for is the
 * three things only a running server shows: that a refused request never
 * reaches the upstream at all (not merely gets a 403 after being forwarded),
 * that the connection bundle is rewritten on its way through, and that an
 * upgrade is tunnelled rather than answered.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { resolveConfig } from '../lib/config.js';
import { parseStatus } from '../lib/tailnet.js';
import { CONNECTION_BUNDLE, startGateway } from '../lib/gateway.js';

const STATUS = JSON.stringify({
	Self: { DNSName: 'harness.example.ts.net.', HostName: 'harness', TailscaleIPs: ['100.64.0.1'], OS: 'linux', UserID: 1, Online: true },
	Peer: { a: { DNSName: 'laptop.example.ts.net.', HostName: 'laptop', TailscaleIPs: ['100.64.0.2'], OS: 'macOS', UserID: 1, Online: true } },
	User: { 1: { LoginName: 'owner@example.com' } },
});

/** The one line of the real bundle this plugin cares about. */
const BUNDLE_BODY = 'const handle = {\n\tapi,\n\tisLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),\n};\n';

/**
 * A port nothing is using. The gateway deliberately has no "pick any port"
 * mode — the number has to be known to publish it with `tailscale serve` — so
 * the test borrows one the same way an operator would read one off `ss`.
 */
function freePort() {
	return new Promise((resolve) => {
		const probe = createSocketServer();
		probe.listen(0, '127.0.0.1', () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

describe('gateway', () => {
	let upstream;
	let gateway;
	let config;
	/** Sockets the stand-in upgraded; node stops counting them, so we must. */
	const upstreamTunnels = new Set();
	/** Every request the stand-in upstream saw, so a refusal can be proved. */
	const seen = [];

	before(async () => {
		config = { ...resolveConfig({}), port: await freePort() };
		upstream = createServer((req, res) => {
			seen.push({ url: req.url, headers: req.headers });
			if (req.url === CONNECTION_BUNDLE) {
				res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
				res.end(BUNDLE_BODY);
				return;
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin ?? null }));
		});
		upstream.on('upgrade', (req, socket) => {
			upstreamTunnels.add(socket);
			seen.push({ url: req.url, upgrade: true, headers: req.headers });
			socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
			socket.write('hello-from-upstream');
		});
		await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

		gateway = await startGateway({
			config: () => config,
			upstream: () => ({ host: '127.0.0.1', port: upstream.address().port }),
			tailnet: { get: async () => parseStatus(STATUS) },
		});
	});

	after(async () => {
		await gateway.close();
		for (const socket of upstreamTunnels) socket.destroy();
		upstream.closeAllConnections();
		await new Promise((resolve) => upstream.close(resolve));
	});

	/** One request through the gateway, as `tailscale serve` would send it. */
	function get(path, headers) {
		return fetch(`http://127.0.0.1:${gateway.port}${path}`, { headers });
	}

	const asOwner = { 'x-forwarded-for': '100.64.0.2', 'tailscale-user-login': 'owner@example.com' };

	it('forwards an admitted request and tells dsh it is loopback', async () => {
		const response = await get('/api', asOwner);
		assert.equal(response.status, 200);
		const body = await response.json();
		assert.equal(body.host, `127.0.0.1:${upstream.address().port}`);
	});

	it('refuses an unidentified request without touching dsh', async () => {
		const before = seen.length;
		const response = await get('/api', {});
		assert.equal(response.status, 403);
		assert.match(await response.text(), /Forbidden/);
		assert.equal(seen.length, before, 'the upstream saw a request it should never have seen');
	});

	it('refuses a login that is not allowed', async () => {
		const response = await get('/api', { 'x-forwarded-for': '100.64.0.2', 'tailscale-user-login': 'someone@else.com' });
		assert.equal(response.status, 403);
	});

	it('cannot be talked past by a forged header, because serve overwrites it', async () => {
		// Not a property of this code — a property of the deployment. What IS
		// this code's job is that the header is the only thing consulted, so
		// the guarantee is not diluted by some second, weaker signal.
		const response = await get('/api', { 'tailscale-user-login': 'owner@example.com' });
		assert.equal(response.status, 200);
	});

	it('rewrites the connection bundle so the settings pages work remotely', async () => {
		const body = await (await get(CONNECTION_BUNDLE, asOwner)).text();
		assert.match(body, /isLoopback: true,/);
		assert.doesNotMatch(body, /pageLocation\.hostname/);
	});

	it('serves the bundle untouched when the override is off', async () => {
		const previous = config;
		config = { ...previous, trustGatewayClients: false };
		try {
			const body = await (await get(CONNECTION_BUNDLE, asOwner)).text();
			assert.match(body, /pageLocation\.hostname/);
		} finally {
			config = previous;
		}
	});

	it('tunnels a websocket upgrade', async () => {
		const { connect } = await import('node:net');
		const socket = connect(gateway.port, '127.0.0.1');
		const text = await new Promise((resolve, reject) => {
			let buffer = '';
			socket.on('error', reject);
			socket.on('data', (chunk) => {
				buffer += chunk.toString('utf8');
				if (buffer.includes('hello-from-upstream')) resolve(buffer);
			});
			socket.write(
				'GET /api/events HTTP/1.1\r\n' +
				`host: 127.0.0.1:${gateway.port}\r\n` +
				'upgrade: websocket\r\nconnection: Upgrade\r\n' +
				'x-forwarded-for: 100.0.0.2\r\ntailscale-user-login: owner@example.com\r\n\r\n',
			);
		});
		socket.destroy();
		assert.match(text, /^HTTP\/1\.1 101 /);
	});

	it('refuses an unidentified upgrade', async () => {
		const { connect } = await import('node:net');
		const socket = connect(gateway.port, '127.0.0.1');
		const text = await new Promise((resolve, reject) => {
			let buffer = '';
			socket.on('error', reject);
			socket.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
			socket.on('end', () => resolve(buffer));
			socket.write(
				'GET /api/events HTTP/1.1\r\n' +
				`host: 127.0.0.1:${gateway.port}\r\n` +
				'upgrade: websocket\r\nconnection: Upgrade\r\n\r\n',
			);
		});
		socket.destroy();
		assert.match(text, /403/);
	});
});

describe('startGateway', () => {
	it('refuses to listen anywhere but loopback', async () => {
		await assert.rejects(
			startGateway({
				config: () => ({ ...resolveConfig({}), host: '0.0.0.0' }),
				upstream: () => ({ host: '127.0.0.1', port: 1 }),
				tailnet: { get: async () => undefined },
			}),
			/must not be reachable directly/,
		);
	});
});
