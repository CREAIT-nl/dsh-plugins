/**
 * Address classification for the local fetch provider.
 *
 * The model chooses `web_fetch`'s URL, so every host it names is attacker-
 * influenced input in the SSRF sense: the interesting targets are not on the
 * public internet but on the loopback interface, the LAN, and the cloud
 * metadata endpoint at 169.254.169.254. This module answers one question —
 * "is this literal IP address one the harness should be reaching over the
 * open web?" — and nothing else, so it stays synchronous, dependency-free and
 * directly testable.
 *
 * @module @creait/dsh-web-fetch/addr
 */

/**
 * IPv4 ranges that must never be reached through `web_fetch`. Each entry is
 * `[first octet match, predicate]`, kept as explicit CIDR comments because the
 * list is security-relevant and a reader must be able to audit it against
 * RFC 1918 / RFC 6890 without decoding bit math.
 */
const BLOCKED_V4 = [
	{ cidr: '0.0.0.0/8', test: (o) => o[0] === 0 },
	{ cidr: '10.0.0.0/8', test: (o) => o[0] === 10 },
	{ cidr: '100.64.0.0/10 (CGNAT)', test: (o) => o[0] === 100 && o[1] >= 64 && o[1] <= 127 },
	{ cidr: '127.0.0.0/8 (loopback)', test: (o) => o[0] === 127 },
	{ cidr: '169.254.0.0/16 (link-local, cloud metadata)', test: (o) => o[0] === 169 && o[1] === 254 },
	{ cidr: '172.16.0.0/12', test: (o) => o[0] === 172 && o[1] >= 16 && o[1] <= 31 },
	{ cidr: '192.0.0.0/24 (IETF protocol assignments)', test: (o) => o[0] === 192 && o[1] === 0 && o[2] === 0 },
	{ cidr: '192.0.2.0/24 (TEST-NET-1)', test: (o) => o[0] === 192 && o[1] === 0 && o[2] === 2 },
	{ cidr: '192.88.99.0/24 (6to4 relay anycast)', test: (o) => o[0] === 192 && o[1] === 88 && o[2] === 99 },
	{ cidr: '192.168.0.0/16', test: (o) => o[0] === 192 && o[1] === 168 },
	{ cidr: '198.18.0.0/15 (benchmarking)', test: (o) => o[0] === 198 && (o[1] === 18 || o[1] === 19) },
	{ cidr: '198.51.100.0/24 (TEST-NET-2)', test: (o) => o[0] === 198 && o[1] === 51 && o[2] === 100 },
	{ cidr: '203.0.113.0/24 (TEST-NET-3)', test: (o) => o[0] === 203 && o[1] === 0 && o[2] === 113 },
	{ cidr: '224.0.0.0/4 (multicast)', test: (o) => o[0] >= 224 && o[0] <= 239 },
	{ cidr: '240.0.0.0/4 (reserved, incl. broadcast)', test: (o) => o[0] >= 240 },
];

/** Parse a dotted-quad into four octets, or null when it is not one. */
function parseV4(address) {
	const parts = address.split('.');
	if (parts.length !== 4) return null;
	const octets = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const value = Number(part);
		if (value > 255) return null;
		octets.push(value);
	}
	return octets;
}

/**
 * Expand an IPv6 address to its eight 16-bit groups, or null when unparseable.
 * Handles `::` elision and a trailing embedded IPv4 literal (`::ffff:127.0.0.1`).
 */
function parseV6(address) {
	let text = address;
	if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
	const zone = text.indexOf('%');
	if (zone !== -1) text = text.slice(0, zone);

	// A trailing dotted-quad occupies the last two groups.
	let tail = [];
	const lastColon = text.lastIndexOf(':');
	const trailer = lastColon === -1 ? '' : text.slice(lastColon + 1);
	if (trailer.includes('.')) {
		const octets = parseV4(trailer);
		if (octets === null) return null;
		tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
		text = text.slice(0, lastColon + 1);
		// `64:ff9b::` keeps its elision marker; `::ffff:` sheds only the
		// separator that preceded the quad. Stripping a colon off `::` would
		// destroy the elision and make the whole address unparseable.
		if (!text.endsWith('::') && text.endsWith(':')) text = text.slice(0, -1);
	}

	const elision = text.indexOf('::');
	let head;
	let rest;
	if (elision === -1) {
		head = text.length === 0 ? [] : text.split(':');
		rest = [];
	} else {
		const before = text.slice(0, elision);
		const after = text.slice(elision + 2);
		head = before.length === 0 ? [] : before.split(':');
		rest = after.length === 0 ? [] : after.split(':');
	}

	const groups = [];
	for (const group of head) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
		groups.push(Number.parseInt(group, 16));
	}
	const trailing = [];
	for (const group of rest) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
		trailing.push(Number.parseInt(group, 16));
	}

	const explicit = groups.length + trailing.length + tail.length;
	if (elision === -1) {
		if (explicit !== 8) return null;
		return [...groups, ...trailing, ...tail];
	}
	if (explicit > 7) return null;
	const zeros = new Array(8 - explicit).fill(0);
	return [...groups, ...zeros, ...trailing, ...tail];
}

/**
 * Classify a literal IP address.
 *
 * IPv4-mapped (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::/96`) addresses are
 * unwrapped and judged as the IPv4 address they carry: without that, `::ffff:
 * 169.254.169.254` would walk straight past an IPv4-only block list.
 *
 * @param address - a literal IPv4 or IPv6 address, without brackets or port.
 * @returns `{ blocked, reason }`; `blocked` is false for a routable public
 *   address and for anything that is not a parseable IP literal (a hostname
 *   reaches this module only after DNS resolution, so a parse failure there is
 *   the caller's error to raise, not a silent allow).
 */
export function classifyAddress(address) {
	const v4 = parseV4(address);
	if (v4 !== null) {
		for (const range of BLOCKED_V4) {
			if (range.test(v4)) return { blocked: true, reason: range.cidr };
		}
		return { blocked: false };
	}

	const v6 = parseV6(address);
	if (v6 === null) return { blocked: false };

	// ::ffff:0:0/96 — IPv4-mapped. Judge the embedded IPv4 address instead.
	if (v6[0] === 0 && v6[1] === 0 && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0xffff) {
		return classifyAddress(v4FromGroups(v6[6], v6[7]));
	}
	// 64:ff9b::/96 — NAT64 well-known prefix, likewise a wrapped IPv4 address.
	if (v6[0] === 0x64 && v6[1] === 0xff9b && v6[2] === 0 && v6[3] === 0 && v6[4] === 0 && v6[5] === 0) {
		return classifyAddress(v4FromGroups(v6[6], v6[7]));
	}

	if (v6.every((group) => group === 0)) return { blocked: true, reason: '::/128 (unspecified)' };
	if (v6.slice(0, 7).every((group) => group === 0) && v6[7] === 1) {
		return { blocked: true, reason: '::1/128 (loopback)' };
	}
	if ((v6[0] & 0xfe00) === 0xfc00) return { blocked: true, reason: 'fc00::/7 (unique local)' };
	if ((v6[0] & 0xffc0) === 0xfe80) return { blocked: true, reason: 'fe80::/10 (link-local)' };
	if ((v6[0] & 0xff00) === 0xff00) return { blocked: true, reason: 'ff00::/8 (multicast)' };
	if (v6[0] === 0x2001 && v6[1] === 0x0db8) return { blocked: true, reason: '2001:db8::/32 (documentation)' };

	return { blocked: false };
}

/** Render two 16-bit groups as the dotted-quad they encode. */
function v4FromGroups(high, low) {
	return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}
