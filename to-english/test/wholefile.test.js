import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lintText, looksTruncated, normalizeEol, cleanNodeError,
  translateWholeFile, WHOLE_FILE_RULES, probeExtension, leakedEnvelope,
} from '../lib/wholefile.js';

/**
 * A throwaway package dir. The manifest is not decoration: without a `type`
 * field the dir is CommonJS, and every ESM fixture below would be a real
 * syntax error rather than the valid file the test means to hand over.
 */
function scratch(type = 'module') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-to-english-whole-'));
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'fixture', type })}\n`, 'utf8');
  return dir;
}

/** An llm stub that hands back a scripted reply per call. */
function scriptedLlm(replies) {
  const seen = [];
  return {
    seen,
    async *streamOne(text) { yield { type: 'text-delta', text }; },
    stream({ messages }) {
      seen.push(messages[messages.length - 1].content[0].text);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('stub ran out of replies');
      return (async function* () { yield { type: 'text-delta', text: reply }; })();
    },
  };
}

test('lintText rejects JavaScript that stopped parsing', () => {
  const dir = scratch();
  const file = join(dir, 'a.js');
  assert.equal(lintText(file, 'export const a = 1\n').ok, true);
  const bad = lintText(file, 'export const a = (1\n');
  assert.equal(bad.ok, false);
  assert.equal(bad.checked, true);
  assert.match(bad.error, /SyntaxError|Unexpected/);
  // The probe file must never survive the check.
  assert.equal(existsSync(join(dir, 'a.dsh-to-english-check.cjs')), false);
});

test('lintText rejects broken JSON and accepts good JSON', () => {
  assert.equal(lintText('/x/p.json', '{"a":1}').ok, true);
  const bad = lintText('/x/p.json', '{"a":1,}');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid JSON/);
});

test('lintText reports honestly when a type has no parser', () => {
  const r = lintText('/x/README.md', '# anything at all');
  assert.equal(r.ok, true);
  assert.equal(r.checked, false, 'markdown is unchecked, not verified');
});

test('cleanNodeError keeps the message and drops the stack and banner', () => {
  const stderr = [
    '/tmp/a.dsh-to-english-check.js:3',
    'const a = (1',
    'SyntaxError: Unexpected end of input',
    '    at wrapSafe (node:internal/modules/cjs/loader)',
    '    at Module._compile (node:internal/modules/cjs/loader)',
    'Node.js v25.8.1',
  ].join('\n');
  const cleaned = cleanNodeError(stderr, '/tmp/a.dsh-to-english-check.js');
  assert.match(cleaned, /SyntaxError: Unexpected end of input/);
  assert.doesNotMatch(cleaned, /\n {4}at /);
  assert.doesNotMatch(cleaned, /Node\.js v/);
  assert.doesNotMatch(cleaned, /\/tmp\//, 'the probe path is rewritten to a bare name');
});

test('looksTruncated catches a cut-off reply but not an honest shortening', () => {
  const original = 'x'.repeat(1000);
  assert.equal(looksTruncated(original, 'x'.repeat(200)), true);
  assert.equal(looksTruncated(original, ''), true);
  assert.equal(looksTruncated(original, 'x'.repeat(900)), false);
  // Chinese spends more bytes per character than the English replacing it, so
  // a real translation does shrink; the floor has to leave room for that.
  assert.equal(looksTruncated('数'.repeat(100), 'count'.repeat(15)), false);
});

test('normalizeEol restores CRLF and the trailing-newline habit', () => {
  assert.equal(normalizeEol('a\nb', 'x\r\ny\r\n'), 'a\r\nb\r\n');
  assert.equal(normalizeEol('a\nb\n', 'x\ny'), 'a\nb');
  assert.equal(normalizeEol('a\nb', 'x\ny\n'), 'a\nb\n');
});

test('the contract tells the model to change a regex shape and to leave names alone', () => {
  assert.match(WHOLE_FILE_RULES, /contents of regular expressions/);
  assert.match(WHOLE_FILE_RULES, /ok\|um\|ah/, 'it carries the worked example');
  assert.match(WHOLE_FILE_RULES, /Do not rename anything the program refers to by name/);
  assert.match(WHOLE_FILE_RULES, /no markdown code fence/);
});

test('a whole-file pass translates a regex the segment gate could never accept', async () => {
  const dir = scratch();
  const file = join(dir, 'gate.js');
  writeFileSync(file, "export const P = [\n  /^[好嗯啊]*\\s*继续/,\n  /^我们?继续/,\n]\n", 'utf8');

  const llm = scriptedLlm(["export const P = [\n  /^(ok|um|ah)*\\s*continue/,\n  /^(i|we)\\s+continue/,\n]\n"]);
  const report = await translateWholeFile(llm, { provider: 'p', model: 'm' }, undefined, dir, file);

  assert.equal(report.status, 'translated');
  assert.equal(report.attempts, 1, 'one pass, no repair needed');
  assert.equal(report.cjkAfter, 0);
  assert.match(readFileSync(file, 'utf8'), /\(ok\|um\|ah\)/);
  assert.equal(readFileSync(`${file}.zh.bak`, 'utf8').includes('好嗯啊'), true, 'the Chinese original is backed up');
});

test('a reply that stopped parsing is quoted back and repaired', async () => {
  const dir = scratch();
  const file = join(dir, 'b.js');
  writeFileSync(file, "export const msg = '你好'\n", 'utf8');

  const llm = scriptedLlm([
    "export const msg = 'hello\n",          // unterminated string
    "export const msg = 'hello'\n",         // the repair
  ]);
  const report = await translateWholeFile(llm, { provider: 'p', model: 'm' }, undefined, dir, file);

  assert.equal(report.status, 'translated');
  assert.equal(report.attempts, 2);
  assert.equal(readFileSync(file, 'utf8'), "export const msg = 'hello'\n");
  assert.equal(report.repaired.length, 1);
  assert.match(report.repaired[0], /attempt 1: the file no longer parses/);
  // The rejection has to reach the model, not just the report.
  assert.match(llm.seen[1], /That output was rejected/);
  assert.match(llm.seen[1], /SyntaxError|Invalid|Unterminated/);
});

test('a file that never parses is left untouched after the attempt budget', async () => {
  const dir = scratch();
  const file = join(dir, 'c.js');
  const original = "export const msg = '你好'\n";
  writeFileSync(file, original, 'utf8');

  const llm = scriptedLlm(["const a = (1\n", "const a = (1\n", "const a = (1\n"]);
  const report = await translateWholeFile(llm, { provider: 'p', model: 'm' }, undefined, dir, file, undefined, 3);

  assert.equal(report.status, 'invalid');
  assert.equal(report.attempts, 3);
  assert.equal(readFileSync(file, 'utf8'), original, 'the original survives a failed run');
  assert.equal(existsSync(`${file}.zh.bak`), false, 'and no backup is written for a file never changed');
});

test('a truncated reply is refused even where no parser would catch it', async () => {
  const dir = scratch();
  const file = join(dir, 'README.md');
  const original = `# 标题\n\n${'说明文字。'.repeat(60)}\n`;
  writeFileSync(file, original, 'utf8');

  const llm = scriptedLlm(['# Title\n\nDocum', `# Title\n\n${'Explanatory text. '.repeat(40)}\n`]);
  const report = await translateWholeFile(llm, { provider: 'p', model: 'm' }, undefined, dir, file);

  assert.equal(report.status, 'translated');
  assert.equal(report.attempts, 2);
  assert.match(report.repaired[0], /looks truncated/);
});

test('an outer code fence is stripped before the file is checked', async () => {
  const dir = scratch();
  const file = join(dir, 'd.js');
  writeFileSync(file, "export const t = '标题'\n", 'utf8');

  const llm = scriptedLlm(["```js\nexport const t = 'Title'\n```"]);
  const report = await translateWholeFile(llm, { provider: 'p', model: 'm' }, undefined, dir, file);

  assert.equal(report.status, 'translated');
  assert.equal(readFileSync(file, 'utf8'), "export const t = 'Title'\n");
});

test('the probe extension is resolved so node --check cannot go ambiguous', () => {
  const dir = scratch();
  // An ambiguous `.js` is the case that silently passed: node fails the
  // CommonJS parse, recognises `export` as ESM, and the retry eats the error.
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n', 'utf8');
  assert.equal(probeExtension(join(dir, 'a.js')), '.cjs');
  writeFileSync(join(dir, 'package.json'), '{"name":"x","type":"module"}\n', 'utf8');
  assert.equal(probeExtension(join(dir, 'a.js')), '.mjs');
  // An explicit extension already settles it and is never second-guessed.
  assert.equal(probeExtension(join(dir, 'a.cjs')), '.cjs');
  assert.equal(probeExtension(join(dir, 'a.mjs')), '.mjs');

  // And the end-to-end consequence: broken ESM in an untyped package.
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n', 'utf8');
  assert.equal(lintText(join(dir, 'a.js'), 'export const a = (1\n').ok, false);
});

test('a probe that cannot be written reports unchecked, never invalid', () => {
  const missing = join(scratch(), 'no-such-dir', 'a.js');
  const r = lintText(missing, 'export const a = (1\n');
  assert.equal(r.ok, true, 'an unwritable probe must not be reported as a syntax error');
  assert.equal(r.checked, false);
  assert.match(r.skipped, /probe write failed/);
});

test('a leaked envelope line is caught, though every parser accepts it', async () => {
  const dir = scratch();
  const file = join(dir, 'e.js');
  writeFileSync(file, "export const t = '标题'\n", 'utf8');

  // `FILE: lib/e.js` is a labelled statement dividing three identifiers, so
  // `node --check` passes it and the file only fails at import time.
  assert.equal(lintText(file, "FILE: lib/e.js\n\nexport const t = 'Title'\n").ok, true,
    'precondition: the parser has no objection to this');

  const llm = scriptedLlm([
    "FILE: lib/e.js\n\nexport const t = 'Title'\n",
    "export const t = 'Title'\n",
  ]);
  const report = await translateWholeFile(llm, { provider: 'p', model: 'm' }, undefined, dir, file);

  assert.equal(report.status, 'translated');
  assert.equal(report.attempts, 2);
  assert.equal(readFileSync(file, 'utf8'), "export const t = 'Title'\n");
  assert.match(report.repaired[0], /which is not part of the file/);
});

test('leakedEnvelope leaves a file that really does start with a label alone', () => {
  const original = "outer: for (const a of b) { break outer }\n";
  assert.equal(leakedEnvelope(original, original), undefined);
  // Unchanged first line is always fine, even when it is label-shaped.
  assert.equal(leakedEnvelope('FILE: x\ncode\n', 'FILE: x\nmore\n'), undefined);
  assert.equal(leakedEnvelope('const a = 1\n', 'FILE: lib/a.js\nconst a = 1\n'), 'FILE: lib/a.js');
  assert.equal(leakedEnvelope('const a = 1\n', "Here is the translated file:\nconst a = 1\n"), 'Here is the translated file:');
  assert.equal(leakedEnvelope('const a = 1\n', 'const a = 1\n'), undefined);
});

test('the contract forbids writing the path into the reply', () => {
  assert.match(WHOLE_FILE_RULES, /no markdown code fence/);
});
