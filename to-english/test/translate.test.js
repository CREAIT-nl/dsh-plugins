/**
 * Unit tests for dsh-to-english pure logic: config resolution, CJK detection,
 * file discovery, code-fence stripping, and watcher package-name parsing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveConfig, DEFAULT_PROMPT } from '../lib/config.js';
import {
  hasCjk,
  countCjk,
  listTranslatableFiles,
  stripCodeFence,
  isInstalledPackage,
  splitLines,
  joinLines,
  findCjkSegments,
  isFunctionalChinese,
  localeTableLines,
  segmentBatches,
  reindent,
  parseJsonReply,
  validateSyntax,
  clampRadius,
  scanLine,
  lineStates,
  keepsStructure,
  DEFAULT_REWRITE_RADIUS,
  MAX_REWRITE_RADIUS,
  englishSiblings,
  yamlScan,
  checkLine,
  dropsOnlyAffixes,
  MAX_AFFIX_CHARS,

  protocolSystem,} from '../lib/translate.js';
import { packageNameFromPath } from '../lib/watcher.js';

/** The production segment cap, restated so a radius can be passed after it. */
const MAX_SEGMENT_LINES_TEST = 40;

test('resolveConfig applies defaults', () => {
  const c = resolveConfig(undefined);
  assert.equal(c.enabled, true);
  assert.equal(c.provider, '');
  assert.equal(c.model, '');
  assert.equal(c.prompt, DEFAULT_PROMPT);
});

test('resolveConfig honors explicit values', () => {
  const c = resolveConfig({ enabled: false, provider: 'dgx', model: 'deepseek-v4-flash', prompt: 'x' });
  assert.equal(c.enabled, false);
  assert.equal(c.provider, 'dgx');
  assert.equal(c.model, 'deepseek-v4-flash');
  assert.equal(c.prompt, 'x');
});

test('resolveConfig falls back to default prompt when blank', () => {
  const c = resolveConfig({ prompt: '   ' });
  assert.equal(c.prompt, DEFAULT_PROMPT);
});

test('hasCjk detects Chinese and not ASCII', () => {
  assert.equal(hasCjk('hello world'), false);
  assert.equal(hasCjk('你好世界'), true);
  assert.equal(hasCjk('mixed 中文 text'), true);
  assert.equal(hasCjk('日本語'), true);
  assert.equal(hasCjk('한국어'), true);
});

test('stripCodeFence removes a single outer fence', () => {
  assert.equal(stripCodeFence('```js\nconst a = 1;\n```', '.js'), 'const a = 1;');
  assert.equal(stripCodeFence('```\nplain\n```', '.md'), 'plain');
  assert.equal(stripCodeFence('no fence here', '.js'), 'no fence here');
});

test('listTranslatableFiles skips node_modules, dist, and non-target extensions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-test-'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'index.js'), 'x');
  writeFileSync(join(dir, 'lib', 'styles.css'), 'x');
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'x');
  writeFileSync(join(dir, 'dist', 'bundle.js'), 'x');
  writeFileSync(join(dir, 'README.md'), 'x');
  writeFileSync(join(dir, 'package.json'), '{}');
  writeFileSync(join(dir, 'pnpm-lock.yaml'), 'x');

  const files = listTranslatableFiles(dir).map((f) => f.replace(dir, ''));
  assert.ok(files.includes('/lib/index.js'));
  assert.ok(files.includes('/README.md'));
  assert.ok(files.includes('/package.json'));
  assert.ok(!files.includes('/lib/styles.css'));
  assert.ok(!files.includes('/node_modules/dep/index.js'));
  assert.ok(!files.includes('/dist/bundle.js'));
  assert.ok(!files.includes('/pnpm-lock.yaml'));
});

test('isInstalledPackage checks for package.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-test-'));
  writeFileSync(join(dir, 'package.json'), '{}');
  assert.equal(isInstalledPackage(dir), true);
  const empty = mkdtempSync(join(tmpdir(), 'te-test-'));
  assert.equal(isInstalledPackage(empty), false);
});

test('packageNameFromPath handles scoped and unscoped', () => {
  const nm = '/profile/node_modules';
  assert.equal(packageNameFromPath('/profile/node_modules/dsh-foo', nm), 'dsh-foo');
  assert.equal(packageNameFromPath('/profile/node_modules/@scope/pkg', nm), '@scope/pkg');
});

// ── line-range machinery ────────────────────────────────────────────────────

test('splitLines/joinLines round-trip byte-identically', () => {
  for (const text of ['a\nb\n', 'a\nb', '', '\n', 'a\r\nb\r\n', 'one line']) {
    const { lines, eol, trailingNewline } = splitLines(text);
    assert.equal(joinLines(lines, eol, trailingNewline), text, JSON.stringify(text));
  }
});

test('findCjkSegments groups contiguous CJK lines', () => {
  const lines = ['const a = 1;', '// 中文', '// 也是中文', 'const b = 2;', 'const c = 3;', '// 第三段'];
  assert.deepEqual(findCjkSegments(lines, MAX_SEGMENT_LINES_TEST, '', 0), [
    { id: 1, start: 1, end: 2 },
    { id: 2, start: 5, end: 5 },
  ]);
});

test('findCjkSegments splits a run longer than the cap', () => {
  const lines = Array.from({ length: 5 }, () => '// 中文');
  assert.deepEqual(findCjkSegments(lines, 2, '', 0), [
    { id: 1, start: 0, end: 1 },
    { id: 2, start: 2, end: 3 },
    { id: 3, start: 4, end: 4 },
  ]);
});

test('findCjkSegments returns nothing for a file with no CJK', () => {
  assert.deepEqual(findCjkSegments(['const a = 1;', 'const b = 2;']), []);
  assert.deepEqual(findCjkSegments(['const a = 1;', 'const b = 2;'], 40, '.js', 3), []);
});

test('segmentBatches splits on the character cap but never on a single segment', () => {
  const lines = ['// 中文一'.repeat(10), 'ok', '// 中文二'.repeat(10)];
  const segments = findCjkSegments(lines, MAX_SEGMENT_LINES_TEST, '', 0);
  assert.equal(segmentBatches(lines, segments, 10_000).length, 1);
  assert.equal(segmentBatches(lines, segments, 10).length, 2);
});

test('reindent forces the original indentation back onto a replacement', () => {
  assert.equal(reindent('    // 中文', '// Chinese'), '    // Chinese');
  assert.equal(reindent('    // 中文', '        // Chinese'), '    // Chinese');
  assert.equal(reindent('\t- 中文', '- Chinese'), '\t- Chinese');
  assert.equal(reindent('no indent', 'none'), 'none');
});

test('countCjk counts characters, not matches', () => {
  assert.equal(countCjk('hello'), 0);
  assert.equal(countCjk('你好'), 2);
  assert.equal(countCjk('a 中 b 文 c'), 2);
});

test('parseJsonReply tolerates fences and surrounding prose', () => {
  assert.deepEqual(parseJsonReply('{"segments":[]}'), { segments: [] });
  assert.deepEqual(parseJsonReply('```json\n{"segments":[]}\n```'), { segments: [] });
  assert.deepEqual(parseJsonReply('Here you go:\n{"segments":[]}\nHope that helps'), { segments: [] });
  assert.equal(parseJsonReply('not json at all'), undefined);
});

test('validateSyntax rejects broken JSON and accepts good JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-test-'));
  const file = join(dir, 'package.json');
  assert.equal(validateSyntax(file, '{"a":1}').ok, true);
  assert.equal(validateSyntax(file, '{"a":1,}').ok, false);
});

test('validateSyntax runs node --check on JavaScript and leaves no probe behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-test-'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const file = join(dir, 'index.js');
  assert.equal(validateSyntax(file, 'export const a = 1;\n').ok, true);
  const bad = validateSyntax(file, 'export const a = ;\n');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /syntax check failed/);
  assert.deepEqual(readdirSync(dir).sort(), ['package.json']);
});

test('validateSyntax reports Markdown as unchecked rather than failing it', () => {
  const result = validateSyntax('/tmp/README.md', 'anything at all');
  assert.equal(result.checked, false);
  assert.equal(result.ok, true);
});

test('listTranslatableFiles skips vendored bundles and our own backups', () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-test-'));
  mkdirSync(join(dir, 'lib', 'vendor'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'index.js'), 'x');
  writeFileSync(join(dir, 'lib', 'index.js.zh.bak'), 'x');
  writeFileSync(join(dir, 'lib', 'vendor', 'tokenizer.json'), '{}');
  const files = listTranslatableFiles(dir).map((f) => f.replace(dir, ''));
  assert.deepEqual(files, ['/lib/index.js']);
});

test('isFunctionalChinese keeps trigger data out of the translator', () => {
  // dsh-recall matches user messages against these; translating them would
  // delete the feature rather than localize it.
  assert.equal(isFunctionalChinese('  /^[好嗯啊]*\\s*继续/,', '.js'), true);
  assert.equal(isFunctionalChinese("    '之前', '上次', '刚才',", '.js'), true);
  assert.equal(isFunctionalChinese('  `回忆`, `回顾`', '.js'), true);
});

test('isFunctionalChinese leaves copy alone', () => {
  assert.equal(isFunctionalChinese('  "recalling": "回忆中…",', '.js'), false);
  assert.equal(isFunctionalChinese('// the row shows "回忆中…" while it runs', '.js'), false);
  assert.equal(isFunctionalChinese(' * 回忆完成', '.js'), false);
  assert.equal(isFunctionalChinese('description: 跨会话搜索', '.yml'), false);
  assert.equal(isFunctionalChinese('- 支持 "继续" 之类的口令', '.md'), false);
});

test('findCjkSegments skips functional lines in code but not in prose', () => {
  const lines = ['const T = [', "  '之前', '上次',", '  /^继续/,', ']', '// 说明文字'];
  assert.deepEqual(findCjkSegments(lines, 40, '.js', 0), [{ id: 1, start: 4, end: 4 }]);
  // The same content in Markdown is prose and stays in scope.
  assert.deepEqual(findCjkSegments(lines, 40, '.md', 0), [{ id: 1, start: 1, end: 2 }, { id: 2, start: 4, end: 4 }]);
});

test('listTranslatableFiles skips docs that name their own language', () => {
  const dir = mkdtempSync(join(tmpdir(), 'to-english-locdoc-'));
  writeFileSync(join(dir, 'README.md'), '# Hello\n');
  writeFileSync(join(dir, 'README.zh.md'), '# 你好\n');
  writeFileSync(join(dir, 'CHANGELOG.zh-CN.md'), '# 更新\n');
  assert.deepEqual(
    listTranslatableFiles(dir).map((f) => f.slice(dir.length + 1)),
    ['README.md'],
  );
});

test('localeTableLines protects a non-English locale table, not the English one', () => {
  const lines = [
    'var zh = {',
    '  "recalling": "回忆中…",',
    '  nested: { "done": "回忆完成" },',
    '};',
    'var en = {',
    '  "recalling": "Recalling…",',
    '};',
    '// 说明',
  ];
  assert.deepEqual([...localeTableLines(lines, '.js')].sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.deepEqual(findCjkSegments(lines, 40, '.js', 0), [{ id: 1, start: 7, end: 7 }]);
});

test('localeTableLines recognizes a quoted language key', () => {
  const lines = ['const locales = {', '  "zh-CN": {', '    a: "你好",', '  },', '  en: {', '    a: "hi",', '  },', '};'];
  assert.deepEqual([...localeTableLines(lines, '.js')].sort((a, b) => a - b), [1, 2, 3]);
});

test('clampRadius keeps the setting inside the range the pipeline accepts', () => {
  assert.equal(clampRadius(undefined), DEFAULT_REWRITE_RADIUS);
  assert.equal(clampRadius('not a number'), DEFAULT_REWRITE_RADIUS);
  assert.equal(clampRadius(0), 0);
  assert.equal(clampRadius(-4), 0);
  assert.equal(clampRadius(2.7), 2);
  assert.equal(clampRadius(99), MAX_REWRITE_RADIUS);
});

test('resolveConfig clamps the rewrite radius', () => {
  assert.equal(resolveConfig(undefined).rewriteRadius, DEFAULT_REWRITE_RADIUS);
  assert.equal(resolveConfig({ rewriteRadius: 0 }).rewriteRadius, 0);
  assert.equal(resolveConfig({ rewriteRadius: 99 }).rewriteRadius, MAX_REWRITE_RADIUS);
  assert.equal(resolveConfig({ rewriteRadius: 'x' }).rewriteRadius, DEFAULT_REWRITE_RADIUS);
});

test('findCjkSegments widens the writable set by the radius', () => {
  const lines = ['const a = 1;', 'plain english', '// 中文', 'more english', 'const b = 2;', 'const c = 3;'];
  // Radius 0 is the strict reading: only the line holding Chinese.
  assert.deepEqual(findCjkSegments(lines, 40, '.js', 0), [{ id: 1, start: 2, end: 2 }]);
  // Radius 1 takes the English clause either side of it.
  assert.deepEqual(findCjkSegments(lines, 40, '.js', 1), [{ id: 1, start: 1, end: 3 }]);
  assert.deepEqual(findCjkSegments(lines, 40, '.js', 2), [{ id: 1, start: 0, end: 4 }]);
});

test('findCjkSegments does not widen past the ends of the file', () => {
  assert.deepEqual(findCjkSegments(['// 中文'], 40, '.js', 2), [{ id: 1, start: 0, end: 0 }]);
});

test('findCjkSegments merges two windows that overlap', () => {
  const lines = ['// 中文', 'between', '// 也是中文'];
  assert.deepEqual(findCjkSegments(lines, 40, '.js', 1), [{ id: 1, start: 0, end: 2 }]);
});

test('widening never reaches into a protected line', () => {
  const lines = [
    'var zh = {',
    '  "recalling": "回忆中…",',
    '};',
    '// 说明文字',
    'const after = 1;',
  ];
  // The locale table is lines 0..2. The comment on line 3 is writable and so
  // is line 4, but the widening stops at the table's closing brace rather
  // than editing it one line at a time from the outside.
  assert.deepEqual(findCjkSegments(lines, 40, '.js', 1), [{ id: 1, start: 3, end: 4 }]);
});

test('widening stops at a line of trigger data', () => {
  const lines = ['const T = [', "  '之前', '上次',", '];', '// 说明文字'];
  assert.deepEqual(findCjkSegments(lines, 40, '.js', 1), [{ id: 1, start: 2, end: 3 }]);
});

test('scanLine strips prose and keeps structure', () => {
  assert.equal(scanLine('const a = "hello";').skeleton, 'const a = " ";');
  assert.equal(scanLine('const a = "goodbye";').skeleton, 'const a = " ";');
  assert.equal(scanLine('const a = 1; // 中文').skeleton, 'const a = 1; //');
  assert.equal(scanLine('const a = 1; // anything at all').skeleton, 'const a = 1; //');
  // An interpolation is code again, so what it computes still counts.
  assert.notEqual(
    scanLine('lines.push(`Summary:${summary.slice(0, 400)}`)').skeleton,
    scanLine('lines.push(`Summary:${summary.slice(0, 40)}`)').skeleton,
  );
  assert.equal(
    scanLine('lines.push(`摘要:${summary.slice(0, 400)}`)').skeleton,
    scanLine('lines.push(`Summary:${summary.slice(0, 400)}`)').skeleton,
  );
});

test('lineStates carries block-comment state across lines', () => {
  const lines = ['/**', ' * 中文注释', ' */', 'const a = 1;'];
  const states = lineStates(lines);
  assert.equal(states[0].mode, 'code');
  assert.equal(states[1].mode, 'block');
  assert.equal(states[2].mode, 'block');
  assert.equal(states[3].mode, 'code');
  // Without that state the middle line reads as code and the rewrite would
  // be rejected — which would reject every JSDoc comment in the package.
  assert.equal(keepsStructure(' * 中文注释', ' * A Chinese comment', states[1], '.js'), true);
});

test('keepsStructure accepts a prose rewrite and refuses a code one', () => {
  const lines = ['const label = "回忆中";', 'const timeout = 400;'];
  const states = lineStates(lines);
  assert.equal(keepsStructure(lines[0], 'const label = "Recalling";', states[0], '.js'), true);
  assert.equal(keepsStructure(lines[0], 'const caption = "Recalling";', states[0], '.js'), false);
  assert.equal(keepsStructure(lines[1], 'const timeout = 4000;', states[1], '.js'), false);
  // Markdown and YAML have no structure to hold on to.
  assert.equal(keepsStructure(lines[1], 'anything at all', states[1], '.md'), true);
});

test('englishSiblings names the English edition of a doc, and only of a doc', () => {
  assert.ok(englishSiblings('README.md').includes('README_EN.md'));
  assert.ok(englishSiblings('README.md').includes('README.en.md'));
  // A file that is already the English edition has no English edition.
  assert.deepEqual(englishSiblings('README_EN.md'), []);
  assert.deepEqual(englishSiblings('README.en.md'), []);
  // Only docs come in language pairs.
  assert.deepEqual(englishSiblings('index.js'), []);
});

test('listTranslatableFiles skips a doc that has an English twin beside it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'te-test-'));
  writeFileSync(join(dir, 'README.md'), '**中文** | [English](README_EN.md)');
  writeFileSync(join(dir, 'README_EN.md'), '[中文](README.md) | **English**');
  writeFileSync(join(dir, 'GUIDE.md'), 'no twin, so it is fair game');

  const files = listTranslatableFiles(dir).map((f) => f.replace(dir, ''));
  assert.ok(!files.includes('/README.md'));
  assert.ok(files.includes('/README_EN.md'));
  assert.ok(files.includes('/GUIDE.md'));
});

test('yamlScan drops the comment body and lifts out quoted scalars', () => {
  assert.equal(yamlScan('# 中文注释').skeleton, '#');
  assert.equal(yamlScan('# anything at all').skeleton, '#');
  assert.equal(yamlScan('- insert:').skeleton, '- insert:');
  assert.deepEqual(yamlScan("      name: 'dsh-enhance'").scalars, ['dsh-enhance']);
  // A `#` inside quotes is not a comment.
  assert.deepEqual(yamlScan('  color: "#ff0000"').scalars, ['#ff0000']);
  assert.equal(yamlScan('  color: "#ff0000"').skeleton, '  color: " "');
});

test('keepsStructure guards a cordis patch at radius 1', () => {
  const ext = '.yml';
  // The line the widened window reaches: it must come back byte-identical.
  assert.equal(keepsStructure('- insert:', '- insert:', undefined, ext), true);
  assert.equal(keepsStructure('- insert:', '- add:', undefined, ext), false);
  assert.equal(keepsStructure("      id: dsh-enhance", "      id: dsh-enhancement", undefined, ext), false);
  // The comment above it is free to be rewritten.
  assert.equal(keepsStructure('# 插入 profile 组合', '# Inserts the row into the profile', undefined, ext), true);
  // An unquoted CJK scalar is locked rather than guessed at.
  // A quoted scalar that held CJK is prose and may become English.
  assert.equal(keepsStructure('  prompt: "你是助手"', '  prompt: "You are an assistant"', undefined, ext), true);
  // One that did not is an identifier and may not.
  assert.equal(keepsStructure("      name: 'dsh-enhance'", "      name: 'dsh-enhancement'", undefined, ext), false);
  assert.equal(keepsStructure('  label: 中文', '  label: Chinese', undefined, ext), false);
});

test('checkLine lets a Chinese circumfix drop its trailing half', () => {
  const state = { mode: 'code', stack: [] };
  // 请求 N 次 -> "Requests N". The trailing literal has nothing left to hold,
  // and the whole-skeleton gate calls its removal a structure change.
  assert.equal(checkLine(
    'React.createElement("span", null, "请求 ", React.createElement("b", null, fmt(d.r)), " 次"),',
    'React.createElement("span", null, "Requests ", React.createElement("b", null, fmt(d.r))),',
    state, '.js',
  ), 'affix');
  // 第 N 次请求 -> "Request #N", the same shape inside a + chain.
  assert.equal(checkLine(
    'const tip = ("第 " + s.idx + " 次请求") + " · 缓存 " + fmt(s.cacheRead);',
    'const tip = ("Request #" + s.idx) + " · Cache " + fmt(s.cacheRead);',
    state, '.js',
  ), 'affix');
  // A plain prose rewrite is still the ordinary answer, not the exemption.
  assert.equal(checkLine('const label = "回忆中";', 'const label = "Recalling";', state, '.js'), 'strict');
});

test('the affix exemption refuses everything that is not an affix', () => {
  const state = { mode: 'code', stack: [] };
  const refuses = (original, replacement, why) =>
    assert.equal(checkLine(original, replacement, state, '.js'), false, why);

  // The only Chinese on the line is the thing being deleted, so nothing was
  // translated — this is an argument going missing, not a circumfix.
  refuses('const x = t("中文标题", fallbackValue);', 'const x = t(fallbackValue);', 'lone literal');
  // Long enough to be content: a prompt must never vanish this way.
  refuses('const P = join("为这个句子生成表示以用于检索相关文章：", rest);', 'const P = join(rest);', 'a whole phrase');
  // A call is not a literal.
  refuses(
    'React.createElement("span", null, "请求 ", React.createElement("b", null, fmt(d.r))),',
    'React.createElement("span", null, "Requests "),',
    'a dropped call',
  );
  // Identifiers still have to match byte for byte.
  refuses(
    'React.createElement("span", null, "请求 ", fmt(a), " 次"),',
    'React.createElement("span", null, "Requests ", fmt(b)),',
    'a rename smuggled in beside the drop',
  );
  // One joiner per affix, so the operands cannot be run together.
  refuses('f(a, "次", b);', 'f(a b);', 'both joiners');
  // An English literal is not ours to remove.
  refuses(
    'React.createElement("span", null, "中文 ", fmt(a), " tok"),',
    'React.createElement("span", null, "Chinese ", fmt(a)),',
    'an English literal',
  );
  // The margin around the Chinese is there to be reworded, never shortened.
  refuses(
    'React.createElement("span", null, "Total ", fmt(a), " tok"),',
    'React.createElement("span", null, "Total ", fmt(a)),',
    'a line that held no Chinese',
  );
  // Numbers are code.
  refuses('const a = f("中文 ", 400, " 次");', 'const a = f("Chinese ");', 'a dropped number');
});

test('dropsOnlyAffixes needs a real deletion, not a rewrite', () => {
  const state = { mode: 'code', stack: [] };
  // Same token count: whatever this is, it is not a dropped affix.
  assert.equal(dropsOnlyAffixes('f("中文", a);', 'f("Chinese", a);', state), false);
  // A literal exactly at the cap is still an affix; one past it is content.
  const cap = '\u6b21'.repeat(MAX_AFFIX_CHARS);
  const over = '\u6b21'.repeat(MAX_AFFIX_CHARS + 1);
  assert.equal(dropsOnlyAffixes(`f("中文 ", a, "${cap}");`, 'f("Chinese ", a);', state), true);
  assert.equal(dropsOnlyAffixes(`f("中文 ", a, "${over}");`, 'f("Chinese ", a);', state), false);
});

test('translateEverything opens the lines the careful mode protects', () => {
  // The real shape of a word bag: entries on their own continuation lines,
  // which is what makes them a line of nothing but literals and commas.
  const lines = [
    'const TRIGGERS = [',
    "  '之前', '上次',",
    '];',
    'var zh = {',
    "  greet: '你好',",
    '};',
    '// 说明文字',
  ];
  // Careful: the trigger data and the zh table are sealed, and the widening
  // stops at them rather than editing them from the outside.
  assert.deepEqual(
    findCjkSegments(lines, 40, '.js', 1, true),
    [{ id: 1, start: 6, end: 6 }],
  );
  // Blunt: every line holding Chinese is writable, because a trigger phrase
  // nobody can type is a switch nothing can flip.
  assert.deepEqual(
    findCjkSegments(lines, 40, '.js', 1, false),
    [{ id: 1, start: 0, end: 6 }],
  );
});

test('the blunt contract swaps the two rules that preserve Chinese', () => {
  const careful = protocolSystem(false).split('\n');
  const blunt = protocolSystem(true).split('\n');
  // Same shape: rules are replaced in place, never added or dropped.
  assert.equal(blunt.length, careful.length);
  const ruleFive = (rules) => rules.find((r) => r.startsWith('5. '));
  const ruleSix = (rules) => rules.find((r) => r.startsWith('6. '));
  assert.match(ruleFive(careful), /not copy: it is data the program acts on/);
  assert.match(ruleFive(blunt), /Translate every Chinese string/);
  assert.match(ruleSix(blunt), /translate the example to the English/);
  // Everything else is identical, the structure rules above all.
  const others = (rules) => rules.filter((r) => !/^[56]\. /.test(r));
  assert.deepEqual(others(blunt), others(careful));
  assert.match(others(blunt).join('\n'), /Change prose, never structure/);
  // The default is the careful one, for any caller that passes no mode.
  assert.equal(protocolSystem(), protocolSystem(false));
});

test('resolveConfig defaults to translating everything', () => {
  assert.equal(resolveConfig(undefined).translateEverything, true);
  assert.equal(resolveConfig({}).translateEverything, true);
  assert.equal(resolveConfig({ translateEverything: false }).translateEverything, false);
  // Only an explicit false turns it off.
  assert.equal(resolveConfig({ translateEverything: 'no' }).translateEverything, true);
});
