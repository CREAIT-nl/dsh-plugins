import assert from 'node:assert/strict';
import { test } from 'node:test';

import { classifyAddress } from '../lib/addr.js';

test('blocks the IPv4 ranges that make SSRF worth doing', () => {
	const blocked = [
		'0.0.0.0',
		'10.1.2.3',
		'100.64.0.1',
		'127.0.0.1',
		'169.254.169.254',
		'172.16.0.1',
		'172.31.255.255',
		'192.168.1.1',
		'198.18.0.1',
		'224.0.0.1',
		'255.255.255.255',
	];
	for (const address of blocked) {
		assert.equal(classifyAddress(address).blocked, true, `${address} must be blocked`);
	}
});

test('allows routable IPv4 addresses, including ones adjacent to blocked ranges', () => {
	const allowed = ['1.1.1.1', '8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1', '223.255.255.255'];
	for (const address of allowed) {
		assert.equal(classifyAddress(address).blocked, false, `${address} must be allowed`);
	}
});

test('blocks IPv6 loopback, unspecified, ULA, link-local and multicast', () => {
	const blocked = ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1'];
	for (const address of blocked) {
		assert.equal(classifyAddress(address).blocked, true, `${address} must be blocked`);
	}
});

test('allows routable IPv6 addresses', () => {
	for (const address of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
		assert.equal(classifyAddress(address).blocked, false, `${address} must be allowed`);
	}
});

test('unwraps IPv4-mapped IPv6 so the metadata endpoint cannot sneak through', () => {
	assert.equal(classifyAddress('::ffff:169.254.169.254').blocked, true);
	assert.equal(classifyAddress('::ffff:127.0.0.1').blocked, true);
	assert.equal(classifyAddress('::ffff:8.8.8.8').blocked, false);
});

test('unwraps the NAT64 well-known prefix the same way', () => {
	assert.equal(classifyAddress('64:ff9b::169.254.169.254').blocked, true);
	assert.equal(classifyAddress('64:ff9b::8.8.8.8').blocked, false);
});

test('accepts bracketed and zoned IPv6 forms', () => {
	assert.equal(classifyAddress('[::1]').blocked, true);
	assert.equal(classifyAddress('fe80::1%en0').blocked, true);
});

test('names the range it blocked on, so the error can explain itself', () => {
	const verdict = classifyAddress('169.254.169.254');
	assert.equal(verdict.blocked, true);
	assert.match(verdict.reason, /169\.254\.0\.0\/16/);
});

test('treats a non-IP string as unclassified rather than silently blocked', () => {
	// Hostnames reach the provider only after resolution; a parse failure here
	// must not be mistaken for a verdict.
	assert.equal(classifyAddress('example.com').blocked, false);
	assert.equal(classifyAddress('').blocked, false);
});
