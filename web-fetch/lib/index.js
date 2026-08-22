/**
 * Local fetch provider for the `ctx.web` capability seam.
 *
 * `dsh-tool-web` already ships the whole model-facing `web_fetch` tool —
 * schema, validation, timeout budget, markdown rendering, truncation footer and
 * the fetch card. What dsh does not ship is a backend for it, so `dsh-base`
 * mounts the tool with `fetch: false` and the seam's fetch side stays empty.
 * The reason is stated in that bundle: the provider is where SSRF protection
 * lives, and the model chooses the request target. This package is that
 * provider, with the guards the seam's own error taxonomy names — invalid or
 * blocked URLs, redirects, size and timeout limits, and unsupported content
 * types.
 *
 * The provider returns the body largely as retrieved and classified (`html` or
 * `text`); `dsh-tool-web` owns the DOM parse and turndown walk that turn HTML
 * into model-facing markdown, so doing any extraction here would only throw
 * away structure the tool is about to use.
 *
 * SSRF posture, stated plainly:
 *   - every hop is re-resolved and re-checked, so a public URL that redirects
 *     to 169.254.169.254 is refused at the redirect, not followed;
 *   - DNS results are checked against the blocked-range list in `./addr.js`;
 *   - `allowHosts` is the escape hatch for deliberately reaching a private host
 *     (a LAN SearXNG, an internal wiki), and it is exact-match by hostname.
 *
 * What this does NOT close: the window between resolving a hostname and the
 * connection actually being made. A hostname whose DNS flips to a private
 * address inside that window (classic DNS rebinding) would be checked as public
 * and connected as private, because global `fetch` re-resolves on its own and
 * offers no pinned-address dispatcher. Closing it needs a custom undici
 * dispatcher whose `connect` re-validates the resolved peer; that is a real
 * dependency, and this package deliberately stays dependency-light. On a
 * trusted workstation network the residual risk is small, but it is not zero
 * and it should not be described as if it were.
 *
 * @module @creait/dsh-web-fetch
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import z from '@deepseek-ai/schemastery';
import { WebError } from '@deepseek-ai/dsh-web';

import { classifyAddress } from './addr.js';

/** Stable id this provider registers under in the fetch capability kind. */
const LOCAL_FETCH_PROVIDER_ID = 'local';

/** Default cap on the decoded body, in bytes. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Default cap on redirect hops followed for one request. */
const DEFAULT_MAX_REDIRECTS = 5;

/** Attribution header sent on every request. */
const USER_AGENT = 'deepseek-harness/0.0.1 (web fetch)';

/**
 * Content types the provider will decode. Anything else is refused rather than
 * guessed at: `web_fetch` returns text to a model, and handing it a decoded PDF
 * or a JPEG as mojibake is worse than an error that says what happened.
 */
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml']);
const TEXT_TYPES = new Set([
	'text/plain',
	'text/markdown',
	'text/csv',
	'text/xml',
	'application/xml',
	'application/json',
	'application/ld+json',
	'application/rss+xml',
	'application/atom+xml',
	'application/javascript',
	'text/javascript',
]);

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error) {
	return error instanceof DOMException && error.name === 'AbortError';
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function fetchAborted(signal, fallback) {
	return new WebError('web fetch aborted', 'WEB_ABORTED', {
		cause: signal?.aborted === true ? signal.reason : fallback,
	});
}

/**
 * Validate one URL's shape before any network work.
 *
 * Credentials in the URL are refused outright: they are never needed for the
 * public-document retrieval `web_fetch` exists to do, and they are a classic
 * way to smuggle a different authority past a careless parser
 * (`https://trusted.example@attacker.example/`).
 *
 * @param raw - the URL as given by the caller or a redirect `Location`.
 * @returns the parsed `URL`.
 */
function parseTarget(raw) {
	let url;
	try {
		url = new URL(raw);
	} catch (error) {
		throw new WebError(`web fetch: not a valid absolute URL: ${raw}`, 'WEB_INVALID_URL', { cause: error });
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new WebError(`web fetch: unsupported scheme ${url.protocol}`, 'WEB_INVALID_URL');
	}
	if (url.username.length > 0 || url.password.length > 0) {
		throw new WebError('web fetch: URLs carrying credentials are refused', 'WEB_INVALID_URL');
	}
	return url;
}

/**
 * Refuse a URL whose host resolves anywhere the harness should not be reaching.
 *
 * A literal IP is judged directly. A hostname is resolved with `dns.lookup`
 * using `all: true`, and EVERY returned address must pass — a name with one
 * public and one loopback address is refused, because which one `fetch` picks
 * is not ours to decide.
 *
 * @param url - the parsed target.
 * @param options - resolved provider options carrying the host allow list.
 */
async function assertReachable(url, options) {
	const hostname = url.hostname;
	const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

	if (options.allowHosts.includes(hostname) || options.allowHosts.includes(bare)) return;
	if (options.blockHosts.includes(hostname) || options.blockHosts.includes(bare)) {
		throw new WebError(`web fetch: host ${hostname} is in blockHosts`, 'WEB_BLOCKED_URL');
	}

	if (isIP(bare) !== 0) {
		const verdict = classifyAddress(bare);
		if (verdict.blocked) {
			throw new WebError(
				`web fetch: ${bare} is in a non-routable range (${verdict.reason}); add the host to allowHosts to reach it deliberately`,
				'WEB_BLOCKED_URL',
			);
		}
		return;
	}

	let addresses;
	try {
		addresses = await lookup(bare, { all: true });
	} catch (error) {
		throw new WebError(`web fetch: cannot resolve ${bare}: ${String(error)}`, 'WEB_BLOCKED_URL', { cause: error });
	}
	if (addresses.length === 0) {
		throw new WebError(`web fetch: ${bare} resolved to no addresses`, 'WEB_BLOCKED_URL');
	}
	for (const entry of addresses) {
		const verdict = classifyAddress(entry.address);
		if (verdict.blocked) {
			throw new WebError(
				`web fetch: ${bare} resolves to ${entry.address}, a non-routable address (${verdict.reason}); add the host to allowHosts to reach it deliberately`,
				'WEB_BLOCKED_URL',
			);
		}
	}
}

/**
 * Split a `content-type` header into its media type and charset.
 *
 * @param header - the raw header value, possibly absent.
 * @returns lowercased `mediaType` (empty when absent) and `charset`.
 */
function parseContentType(header) {
	if (typeof header !== 'string' || header.length === 0) return { mediaType: '', charset: 'utf-8' };
	const [first, ...params] = header.split(';');
	let charset = 'utf-8';
	for (const param of params) {
		const match = /^\s*charset\s*=\s*"?([^";]+)"?\s*$/i.exec(param);
		if (match) charset = match[1].trim().toLowerCase();
	}
	return { mediaType: first.trim().toLowerCase(), charset };
}

/**
 * Read a response body, stopping once `maxBytes` have been buffered.
 *
 * Streaming rather than `response.arrayBuffer()` is the point: a size cap that
 * only applies after the whole body is in memory is not a cap. The reader is
 * cancelled on the way out so a capped fetch does not leave the socket draining.
 *
 * @param response - the fetch response whose body is being read.
 * @param maxBytes - byte ceiling for the buffered body.
 * @returns the buffered bytes and whether the body was cut short.
 */
async function readCapped(response, maxBytes) {
	if (response.body === null) return { bytes: new Uint8Array(0), truncated: false };
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	let truncated = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			if (total + value.byteLength >= maxBytes) {
				chunks.push(value.subarray(0, maxBytes - total));
				total = maxBytes;
				truncated = true;
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

/** Decode bytes with the declared charset, falling back to UTF-8 for unknown labels. */
function decodeBody(bytes, charset) {
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		return new TextDecoder('utf-8').decode(bytes);
	}
}

/** Project one resolved config section into the options used for a fetch. */
function resolveOptions(config) {
	return {
		maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
		maxRedirects: config.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
		allowHosts: config.allowHosts ?? [],
		blockHosts: config.blockHosts ?? [],
		userAgent: config.userAgent ?? USER_AGENT,
	};
}

/** The local, guarded fetch provider. */
class LocalFetchProvider {
	constructor(resolveOptionsThunk) {
		this.resolveOptionsThunk = resolveOptionsThunk;
	}

	id = LOCAL_FETCH_PROVIDER_ID;

	available() {
		return typeof globalThis.fetch === 'function';
	}

	async fetch(request, signal) {
		const options = this.resolveOptionsThunk();
		if (signal?.aborted === true) throw fetchAborted(signal);

		let target = parseTarget(request.url);
		let response;
		let hops = 0;

		// Redirects are followed by hand so every hop is re-validated. `fetch`'s
		// own `redirect: 'follow'` would check the first URL and then quietly
		// connect wherever the chain led.
		for (;;) {
			await assertReachable(target, options);
			if (signal?.aborted === true) throw fetchAborted(signal);

			try {
				response = await globalThis.fetch(target, {
					method: 'GET',
					redirect: 'manual',
					headers: {
						accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
						'accept-language': 'en',
						'user-agent': options.userAgent,
					},
					...signal !== undefined ? { signal } : {},
				});
			} catch (error) {
				if (signal?.aborted === true || isAbortError(error)) throw fetchAborted(signal, error);
				throw new WebError(`web fetch request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error });
			}

			const location = response.headers.get('location');
			const isRedirect = response.status >= 300 && response.status < 400 && location !== null;
			if (!isRedirect) break;

			hops += 1;
			if (hops > options.maxRedirects) {
				throw new WebError(
					`web fetch: more than ${options.maxRedirects} redirects starting at ${request.url}`,
					'WEB_TOO_MANY_REDIRECTS',
				);
			}
			// A relative Location resolves against the hop it came from.
			target = parseTarget(new URL(location, target).href);
			await response.body?.cancel().catch(() => {});
		}

		const { mediaType, charset } = parseContentType(response.headers.get('content-type'));
		// An absent content-type is treated as text: servers omit it on plain
		// documents often enough that refusing would cost more than it protects,
		// and the size cap still bounds whatever comes back.
		const kind = HTML_TYPES.has(mediaType) ? 'html' : TEXT_TYPES.has(mediaType) || mediaType === '' ? 'text' : null;
		if (kind === null) {
			await response.body?.cancel().catch(() => {});
			throw new WebError(
				`web fetch: ${target.href} returned unsupported content type ${mediaType}`,
				'WEB_UNSUPPORTED_CONTENT_TYPE',
			);
		}

		let read;
		try {
			read = await readCapped(response, options.maxBytes);
		} catch (error) {
			if (signal?.aborted === true || isAbortError(error)) throw fetchAborted(signal, error);
			throw new WebError(`web fetch: reading ${target.href} failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', {
				cause: error,
			});
		}

		return {
			url: target.href,
			statusCode: response.status,
			body: { kind, content: decodeBody(read.bytes, charset) },
			truncated: read.truncated,
		};
	}
}

const Config = z.object({
	maxBytes: z.number().step(1).min(1024).default(DEFAULT_MAX_BYTES),
	maxRedirects: z.number().step(1).min(0).default(DEFAULT_MAX_REDIRECTS),
	allowHosts: z.array(z.string()).default([]),
	blockHosts: z.array(z.string()).default([]),
	userAgent: z.string().default(USER_AGENT),
});

/** Cordis plugin name used by loader diagnostics. */
const name = 'web-fetch';

const inject = ['web'];

/** Register the local fetch provider with `ctx.web`. */
function apply(ctx, config) {
	const resolve = () => resolveOptions(config ?? {});
	// Register returns a disposer owned by this fiber; stop/update removes it.
	ctx.web.registerFetchProvider(new LocalFetchProvider(resolve));
}

export {
	Config,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_REDIRECTS,
	LOCAL_FETCH_PROVIDER_ID,
	LocalFetchProvider,
	apply,
	inject,
	name,
	parseContentType,
	parseTarget,
	readCapped,
};
