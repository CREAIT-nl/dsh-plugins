import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { LocalFetchProvider, parseContentType, parseTarget, readCapped } from '../lib/index.js';

const realFetch = globalThis.fetch;
after(() => {
	globalThis.fetch = realFetch;
});

/** Build a provider over a fixed option set. */
function provider(options = {}) {
	return new LocalFetchProvider(() => ({
		maxBytes: 1024 * 1024,
		maxRedirects: 5,
		allowHosts: [],
		blockHosts: [],
		userAgent: 'test',
		...options,
	}));
}

/** A Response whose body streams `text` in small chunks. */
function textResponse(text, { status = 200, type = 'text/plain', headers = {} } = {}) {
	const bytes = new TextEncoder().encode(text);
	const stream = new ReadableStream({
		start(controller) {
			for (let i = 0; i < bytes.length; i += 8) controller.enqueue(bytes.subarray(i, i + 8));
			controller.close();
		},
	});
	return new Response(stream, {
		status,
		headers: { 'content-type': type, ...headers },
	});
}

test('parseTarget refuses non-http schemes, credentials and malformed URLs', () => {
	assert.throws(() => parseTarget('file:///etc/passwd'), /unsupported scheme/);
	assert.throws(() => parseTarget('ftp://example.com/x'), /unsupported scheme/);
	assert.throws(() => parseTarget('https://user:pw@example.com/'), /credentials/);
	assert.throws(() => parseTarget('not a url'), /not a valid absolute URL/);
	assert.equal(parseTarget('https://example.com/a').href, 'https://example.com/a');
});

test('parseContentType splits media type from charset', () => {
	assert.deepEqual(parseContentType('text/html; charset=ISO-8859-1'), {
		mediaType: 'text/html',
		charset: 'iso-8859-1',
	});
	assert.deepEqual(parseContentType('application/json'), { mediaType: 'application/json', charset: 'utf-8' });
	assert.deepEqual(parseContentType(null), { mediaType: '', charset: 'utf-8' });
});

test('readCapped stops at the ceiling and reports truncation', async () => {
	const capped = await readCapped(textResponse('x'.repeat(500)), 100);
	assert.equal(capped.bytes.byteLength, 100);
	assert.equal(capped.truncated, true);

	const whole = await readCapped(textResponse('hello'), 100);
	assert.equal(new TextDecoder().decode(whole.bytes), 'hello');
	assert.equal(whole.truncated, false);
});

test('refuses a blocked address given as a literal, naming the range', async () => {
	await assert.rejects(
		provider().fetch({ url: 'http://169.254.169.254/latest/meta-data/' }),
		/non-routable range \(169\.254\.0\.0\/16/,
	);
	await assert.rejects(provider().fetch({ url: 'http://127.0.0.1:8080/' }), /non-routable range/);
});

test('re-validates every redirect hop, so a public URL cannot bounce to metadata', async () => {
	const seen = [];
	globalThis.fetch = async (url) => {
		seen.push(String(url));
		return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } });
	};

	await assert.rejects(provider().fetch({ url: 'http://8.8.8.8/start' }), /non-routable range \(169\.254\.0\.0\/16/);
	// The first hop was fetched; the redirect target never was.
	assert.deepEqual(seen, ['http://8.8.8.8/start']);
});

test('caps the redirect chain', async () => {
	let n = 0;
	globalThis.fetch = async () => {
		n += 1;
		return new Response(null, { status: 302, headers: { location: `http://8.8.8.8/hop${n}` } });
	};

	await assert.rejects(
		provider({ maxRedirects: 3 }).fetch({ url: 'http://8.8.8.8/start' }),
		/more than 3 redirects/,
	);
});

test('allowHosts is the deliberate escape hatch for a private host', async () => {
	globalThis.fetch = async () => textResponse('lan wiki', { type: 'text/plain' });

	const result = await provider({ allowHosts: ['192.168.1.10'] }).fetch({ url: 'http://192.168.1.10/page' });
	assert.equal(result.statusCode, 200);
	assert.equal(result.body.content, 'lan wiki');
});

test('blockHosts refuses a host that would otherwise be reachable', async () => {
	globalThis.fetch = async () => textResponse('nope');
	await assert.rejects(
		provider({ blockHosts: ['8.8.8.8'] }).fetch({ url: 'http://8.8.8.8/x' }),
		/in blockHosts/,
	);
});

test('classifies html and text bodies for the tool to render', async () => {
	globalThis.fetch = async () => textResponse('<h1>hi</h1>', { type: 'text/html; charset=utf-8' });
	const html = await provider().fetch({ url: 'http://8.8.8.8/page' });
	assert.equal(html.body.kind, 'html');
	assert.equal(html.body.content, '<h1>hi</h1>');

	globalThis.fetch = async () => textResponse('{"a":1}', { type: 'application/json' });
	const json = await provider().fetch({ url: 'http://8.8.8.8/api' });
	assert.equal(json.body.kind, 'text');
});

test('refuses a content type it cannot honestly turn into text', async () => {
	globalThis.fetch = async () => textResponse('%PDF-1.7', { type: 'application/pdf' });
	await assert.rejects(provider().fetch({ url: 'http://8.8.8.8/doc.pdf' }), /unsupported content type application\/pdf/);
});

test('a missing content-type is read as text rather than refused', async () => {
	globalThis.fetch = async () =>
		new Response(new TextEncoder().encode('bare'), { status: 200, headers: {} });
	const result = await provider().fetch({ url: 'http://8.8.8.8/bare' });
	assert.equal(result.body.kind, 'text');
});

test('a non-2xx response is a result, not an error', async () => {
	globalThis.fetch = async () => textResponse('gone', { status: 404 });
	const result = await provider().fetch({ url: 'http://8.8.8.8/missing' });
	assert.equal(result.statusCode, 404);
	assert.equal(result.body.content, 'gone');
});

test('reports the final URL after redirects', async () => {
	let hop = 0;
	globalThis.fetch = async () => {
		hop += 1;
		if (hop === 1) return new Response(null, { status: 301, headers: { location: '/final' } });
		return textResponse('arrived');
	};
	const result = await provider().fetch({ url: 'http://8.8.8.8/start' });
	assert.equal(result.url, 'http://8.8.8.8/final');
	assert.equal(result.body.content, 'arrived');
});

test('honours an already-aborted signal without touching the network', async () => {
	globalThis.fetch = async () => {
		throw new Error('must not be called');
	};
	await assert.rejects(
		provider().fetch({ url: 'http://8.8.8.8/x' }, AbortSignal.abort('stop')),
		/aborted/,
	);
});

const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];

function withProxyEnv(on) {
	const prev = new Map(PROXY_VARS.map((v) => [v, process.env[v]]));
	for (const v of PROXY_VARS) {
		if (on) process.env[v] = 'http://proxy.invalid:8080';
		else delete process.env[v];
	}
	return () => {
		for (const [v, value] of prev) {
			if (value === undefined) delete process.env[v];
			else process.env[v] = value;
		}
	};
}

test('an unresolvable host is refused when no proxy is configured', async () => {
	const restore = withProxyEnv(false);
	globalThis.fetch = async () => {
		throw new Error('must not be called');
	};
	try {
		await assert.rejects(provider().fetch({ url: 'http://unreachable.invalid/' }), /cannot resolve/);
	} finally {
		restore();
	}
});

test('with a proxy configured, a locally-unresolvable host falls through to the proxied fetch', async () => {
	const restore = withProxyEnv(true);
	globalThis.fetch = async () => textResponse('via proxy', { type: 'text/plain' });
	try {
		const result = await provider().fetch({ url: 'http://unreachable.invalid/' });
		assert.equal(result.body.content, 'via proxy');
	} finally {
		restore();
	}
});
