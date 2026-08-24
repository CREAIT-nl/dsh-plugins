/**
 * Translation pipeline: find the human-facing files of an installed plugin
 * package and rewrite their Chinese copy into English through the harness
 * `llm` service (reusing an already-configured provider/model connection).
 *
 * The unit of work is a **line range**, not a file. The model reads the whole
 * file, but it may only write back the lines we hand it. Letting it rewrite
 * the file itself is how a 42 KB source with 86 Chinese characters gets
 * silently reformatted, re-indented, or truncated: 42 KB re-emitted to change
 * 86 characters, and every one of those bytes is a chance to break the plugin.
 * So comprehension and write scope are separated. The whole file goes along as
 * read-only context — that is what lets the model see that a string sits in a
 * `zh` table beside an `en` one, or that a constant is handed to an embedder —
 * while the writable set stays the runs of lines that carry CJK, plus a
 * configurable margin of lines either side so a sentence broken across lines,
 * or a comment that mixes both languages, can be made to read as one whole.
 * Every other byte of the file is preserved by construction: it is never in
 * the writable set, so there is nothing for the model to return in its place.
 *
 * On top of that invariant, three gates stand between the model and the disk:
 * the original indentation is re-applied to each replaced line, the rebuilt
 * file must still parse, and the untouched original is kept as a `.zh.bak`
 * sibling. A file that fails any gate is left exactly as it was.
 *
 * The `llm` service is the same one the conversation uses, so no new
 * connection is configured: the user picks a provider/model that already
 * exists in Settings → Models, and the adapter handles baseURL/API key.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

/** Files we rewrite. Everything else is left alone. */
const TRANSLATE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.yml', '.yaml', '.md', '.json']);

/**
 * Directories never scanned. `vendor` earns its place here: plugins ship
 * bundled runtimes there (dsh-recall vendors a 362 KB tokenizer and the whole
 * onnxruntime web build), and a vendored artifact is never ours to rewrite.
 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.dsh-market', '.pnpm', 'vendor']);

/** Files never rewritten even inside a scanned dir. */
const SKIP_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'tsconfig.json']);

/** A doc that names its own language: README.zh.md, CHANGELOG.zh-CN.md. */
const LOCALIZED_DOC = /\.(zh|zh-cn|zh-tw|zh-hans|zh-hant|ja|ko)\.(md|markdown)$/i;

/** Doc extensions that can come in a language pair. */
const DOC_EXTENSIONS = new Set(['.md', '.markdown']);

/**
 * The names an English edition of `name` could be filed under.
 *
 * The `.zh.md` convention marks the Chinese half; the other half of the same
 * convention marks the English one and leaves the Chinese file called plain
 * `README.md`. dsh-enhance ships exactly that: a Chinese `README.md` whose
 * first line is `**中文** | [English](README_EN.md)`. Translating it writes a
 * second English README and breaks the pair of switch links that point at
 * each other.
 */
export function englishSiblings(name) {
  const ext = extname(name).toLowerCase();
  if (!DOC_EXTENSIONS.has(ext)) return [];
  const stem = name.slice(0, name.length - ext.length);
  if (/[._-](en|en-us|en-gb|english)$/i.test(stem)) return [];
  const suffixes = ['_EN', '_en', '-EN', '-en', '.en', '.EN', '_English', '-english'];
  return suffixes.map((suffix) => `${stem}${suffix}${extname(name)}`);
}

/** Suffix of the untouched copy kept beside every file we rewrite. */
export const BACKUP_SUFFIX = '.zh.bak';

/** Files larger than this are reported as skipped rather than translated. */
const MAX_FILE_BYTES = 512 * 1024;

/** Longest run of CJK lines sent as one segment before it is split. */
const MAX_SEGMENT_LINES = 40;

/** Untranslated lines sent either side of a segment, for meaning only. */
const CONTEXT_LINES = 3;

/**
 * How many lines without CJK on each side of a line with CJK also become
 * writable.
 *
 * Zero is the strictest reading — only lines holding Chinese may change — but
 * it translates a mixed line into English that reads as a graft, because the
 * English half of the thought sits on the line above and cannot be touched.
 * One line of margin is enough to fix a broken clause without opening up the
 * file; the structure check below is what stops that margin being used to
 * rewrite code.
 */
export const DEFAULT_REWRITE_RADIUS = 1;

/** Widest margin the setting accepts. */
export const MAX_REWRITE_RADIUS = 5;

/** Largest file body carried alongside a batch as read-only context. */
const MAX_CONTEXT_CHARS = 120 * 1024;

/** Soft cap on the characters of translatable text in one model call. */
const MAX_BATCH_CHARS = 6000;

/** Extensions `node --check` can parse. Others are written unvalidated. */
const NODE_CHECKABLE = new Set(['.js', '.cjs', '.mjs']);

/** CJK ranges worth translating: Han, Hiragana/Katakana, Hangul. */
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

/** Global form of {@link CJK_PATTERN}, for counting. */
const CJK_PATTERN_GLOBAL = new RegExp(CJK_PATTERN.source, 'g');

/**
 * Whether a text plausibly contains CJK that would benefit from translation.
 * Used to skip files with no Chinese at all (fast path, avoids an LLM call).
 */
export function hasCjk(text) {
  return CJK_PATTERN.test(text);
}

/** How many CJK characters a text contains. Used for before/after reporting. */
export function countCjk(text) {
  const matches = String(text ?? '').match(CJK_PATTERN_GLOBAL);
  return matches === null ? 0 : matches.length;
}

/**
 * Recursively list translatable files under a package dir, skipping
 * dependencies and build output.
 * @param packageDir - absolute path to the installed package.
 * @returns absolute file paths, sorted.
 */
export function listTranslatableFiles(packageDir) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (SKIP_FILES.has(entry.name)) continue;
      // Our own backups are not input for a second pass.
      if (entry.name.endsWith(BACKUP_SUFFIX)) continue;
      // A doc named as the Chinese edition is the source language on purpose,
      // and its English counterpart is the file sitting next to it. Rewriting
      // it would spend the whole budget producing a second English README
      // under a name that says it is Chinese.
      if (LOCALIZED_DOC.test(entry.name)) continue;
      // Same reasoning, the other way round: a doc with an English edition
      // beside it is itself the localized half, whatever it is called.
      if (englishSiblings(entry.name).some((sibling) => existsSync(join(dir, sibling)))) continue;
      const ext = extname(entry.name).toLowerCase();
      if (!TRANSLATE_EXTENSIONS.has(ext)) continue;
      out.push(full);
    }
  };
  walk(packageDir);
  return out.sort();
}

/**
 * Split text into lines while remembering how to put it back together
 * byte-identically: the dominant line ending, and whether the file ended with
 * one. Rejoining an untouched file must produce the original bytes.
 * @param text - the file content.
 * @returns { lines, eol, trailingNewline }
 */
export function splitLines(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -(eol === '\r\n' ? 2 : 1)) : text;
  return { lines: body.length === 0 ? [] : body.split(eol), eol, trailingNewline };
}

/** Inverse of {@link splitLines}. */
export function joinLines(lines, eol, trailingNewline) {
  return lines.join(eol) + (trailingNewline ? eol : '');
}

/** Extensions whose CJK can be executable data rather than copy. */
const CODE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx']);

/** A regular-expression literal, with character classes and escapes. */
const REGEX_LITERAL = /\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[gimsuy]*/g;

/** A row that is nothing but quoted literals and commas. */
const STRING_LIST_ROW = /^(?:(?:'[^'\n]*'|"[^"\n]*"|`[^`\n]*`)\s*,?\s*)+$/;

/**
 * Whether a line's Chinese is functional — something the program matches on or
 * sends to another system — rather than copy a reader sees.
 *
 * Not every Chinese string in a plugin is prose. dsh-recall matches user
 * messages against a list of Chinese trigger phrases and a set of Chinese
 * regexes; translating those does not localize the plugin, it deletes the
 * feature. Two shapes say "data" unambiguously, and both are left untouched:
 * a regex literal containing CJK, and a line made only of quoted literals and
 * commas (a keyword list, one row of it). Comments are prose whatever they
 * quote, so they are exempt from both.
 *
 * This is the deterministic half. The protocol prompt asks the model to leave
 * the subtler cases — a constant that is really a wire string, say — alone as
 * well, but only what is recognizable here is actually guaranteed.
 *
 * @param line - the line as it stands.
 * @param ext - the file's extension, lowercased, with the dot.
 * @returns true when the line must be passed through untranslated.
 */
export function isFunctionalChinese(line, ext) {
  if (!CODE_EXTENSIONS.has(ext)) return false;
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
  REGEX_LITERAL.lastIndex = 0;
  for (const match of trimmed.match(REGEX_LITERAL) ?? []) {
    if (hasCjk(match)) return true;
  }
  return STRING_LIST_ROW.test(trimmed);
}

/** A language tag that is not English, as an identifier or a quoted key. */
const NON_ENGLISH_TAG = /^(?:zh|zhCN|zhTW|zhHans|zhHant|zh[-_](?:cn|tw|hans|hant)|ja|jp|ko|kr)$/i;

/** The head of an object literal bound to a language tag: `var zh = {`. */
const LOCALE_TABLE_HEAD = new RegExp(
  '(?:'
  + '(?:var|let|const)\\s+([A-Za-z_$][\\w$-]*)\\s*=\\s*\\{'
  + '|[\'"`]?([A-Za-z][\\w-]*)[\'"`]?\\s*:\\s*\\{'
  + ')\\s*$',
);

/**
 * The lines inside a locale table for a language other than English.
 *
 * A plugin that ships `var zh = {...}` beside `var en = {...}` is already
 * bilingual: the Chinese values are what a reader who selected Chinese sees,
 * addressed by that key. Translating them does not make the plugin English —
 * the English is already in the table next door — it makes the Chinese option
 * serve English to the people who asked for Chinese. dsh-recall is exactly
 * this shape, and it is the one thing a first pass got wrong.
 *
 * The block is found by its head line and closed by brace depth, so nested
 * objects inside the table are covered too.
 *
 * @param lines - the file's lines.
 * @param ext - the file's extension, lowercased, with the dot.
 * @returns the set of 0-based line indices to leave untouched.
 */
export function localeTableLines(lines, ext) {
  const protectedLines = new Set();
  if (!CODE_EXTENSIONS.has(ext)) return protectedLines;
  for (let i = 0; i < lines.length; i += 1) {
    const head = LOCALE_TABLE_HEAD.exec(lines[i].trim());
    if (head === null) continue;
    const tag = head[1] ?? head[2] ?? '';
    if (!NON_ENGLISH_TAG.test(tag)) continue;
    let depth = 0;
    for (let j = i; j < lines.length; j += 1) {
      for (const ch of lines[j]) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      protectedLines.add(j);
      if (depth <= 0) { i = j; break; }
    }
  }
  return protectedLines;
}

/** Clamp a configured rewrite radius into the range the pipeline accepts. */
export function clampRadius(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_REWRITE_RADIUS;
  return Math.min(MAX_REWRITE_RADIUS, Math.max(0, Math.floor(n)));
}

/**
 * Locate the writable line ranges of a file.
 *
 * A line carrying CJK seeds a range, and the range is then widened by
 * `radius` lines on each side so the English around a translated clause can
 * be brought into agreement with it. A run longer than `maxLines` is split so
 * no single model call has to hold a whole file.
 *
 * With `preserveFunctional`, lines whose Chinese is functional (see
 * {@link isFunctionalChinese}) or sits inside a non-English locale table (see
 * {@link localeTableLines}) are never writable — not as a seed, and not by
 * being next to one. Such a line also stops the widening where it stands:
 * what lies beyond it belongs to a different thought, and reaching across it
 * would be how a protected table gets edited one line at a time from outside.
 *
 * Without it, every line holding CJK is writable. That is the right default
 * for a single-language install: preserving a Chinese trigger phrase keeps
 * the plugin working for a Chinese speaker, and on an English-only harness
 * the same phrase is a switch nothing can flip. Translating it is what turns
 * the feature back on. Note this only ever governs Chinese *behaviour* — the
 * structure gate that stops the model editing code is not on this switch.
 *
 * @param lines - the file's lines.
 * @param maxLines - longest run emitted as one segment.
 * @param ext - the file's extension, for the functional-Chinese guard.
 * @param radius - lines without CJK made writable on each side of a CJK line.
 * @param preserveFunctional - keep Chinese the program matches on or serves
 *   to Chinese users. Default true; the plugin's own config defaults to off.
 * @returns segments as { id, start, end } with inclusive 0-based bounds.
 */
export function findCjkSegments(lines, maxLines = MAX_SEGMENT_LINES, ext = '', radius = DEFAULT_REWRITE_RADIUS, preserveFunctional = true) {
  const inLocaleTable = preserveFunctional ? localeTableLines(lines, ext) : new Set();
  const isProtected = (index) => preserveFunctional
    && (isFunctionalChinese(lines[index], ext) || inLocaleTable.has(index));
  const reach = clampRadius(radius);

  const writable = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    if (!hasCjk(lines[i]) || isProtected(i)) continue;
    writable.add(i);
    for (const step of [-1, 1]) {
      for (let distance = 1; distance <= reach; distance += 1) {
        const neighbour = i + step * distance;
        if (neighbour < 0 || neighbour >= lines.length) break;
        if (isProtected(neighbour)) break;
        writable.add(neighbour);
      }
    }
  }

  const segments = [];
  let start = -1;
  const flush = (end) => {
    for (let from = start; from <= end; from += maxLines) {
      segments.push({ id: segments.length + 1, start: from, end: Math.min(from + maxLines - 1, end) });
    }
    start = -1;
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (writable.has(i)) {
      if (start === -1) start = i;
      continue;
    }
    if (start !== -1) flush(i - 1);
  }
  if (start !== -1) flush(lines.length - 1);
  return segments;
}

/**
 * Group segments into model calls, bounded by the characters of translatable
 * text each call carries.
 * @param lines - the file's lines.
 * @param segments - from {@link findCjkSegments}.
 * @param maxChars - soft cap per batch.
 * @returns batches of segments, in order.
 */
export function segmentBatches(lines, segments, maxChars = MAX_BATCH_CHARS) {
  const batches = [];
  let batch = [];
  let size = 0;
  for (const segment of segments) {
    let chars = 0;
    for (let i = segment.start; i <= segment.end; i += 1) chars += lines[i].length + 1;
    if (batch.length > 0 && size + chars > maxChars) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(segment);
    size += chars;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/** The leading whitespace of a line. */
export function leadingWhitespace(line) {
  const match = /^[ \t]*/.exec(line);
  return match === null ? '' : match[0];
}

/**
 * Force a replacement line back onto the original's indentation. Models like
 * to normalize leading whitespace, and in YAML that silently changes the
 * document's structure rather than its prose.
 * @param original - the line as it was.
 * @param replacement - the line the model returned.
 * @returns the replacement carrying the original's indentation.
 */
export function reindent(original, replacement) {
  return leadingWhitespace(original) + replacement.replace(/^[ \t]*/, '');
}

/** Extensions whose returned lines must keep their code structure intact. */
const STRUCTURED_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.json']);

/** Stands in for the prose of one string literal, so any two differ only in structure. */
const PROSE_MARK = ' ';

/**
 * Split a skeleton back into tokens, re-attaching each masked string to the
 * text it stood for. Every string is one `str` token whatever it holds, so two
 * lines that differ only in what a literal says produce identical token lists;
 * everything else splits into identifiers, numbers, operators and delimiters.
 *
 * @param skeleton - the output of {@link scanLine}.
 * @param bodies - the string contents that skeleton masked, in order.
 * @returns a flat token list: { kind: 'str', cjk, text } or { kind: 'code', text }.
 */
function tokenizeSkeleton(skeleton, bodies) {
  const tokens = [];
  let taken = 0;
  const pattern = /(['"]) \1|[A-Za-z_$][\w$]*|\d[\w.]*|=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|\.\.\.|\S/g;
  let match;
  while ((match = pattern.exec(skeleton)) !== null) {
    if (match[1] === undefined) {
      tokens.push({ kind: 'code', text: match[0] });
      continue;
    }
    const text = bodies[taken] ?? '';
    taken += 1;
    tokens.push({ kind: 'str', cjk: hasCjk(text), text });
  }
  return tokens;
}

/**
 * Reduce a line to its code structure, dropping every character that is prose:
 * the body of a comment, the text inside a string literal. What is left is
 * identifiers, keywords, operators, punctuation, and the delimiters themselves.
 *
 * This is the gate that makes a widened writable window safe. The margin
 * around a Chinese line is there so the model can rephrase the English of a
 * split sentence — but the margin lands on real code just as often, and
 * `node --check` only catches a line that stops parsing, not one that still
 * parses and now does something else. Comparing structure before and after
 * pins the difference to prose, or rejects the line.
 *
 * Lexical state carries across lines, so the caller threads it through: the
 * middle line of a JSDoc block is indistinguishable from code on its own, and
 * treating it as code is exactly how this check would reject every comment we
 * came here to translate.
 *
 * @param line - the line to reduce.
 * @param state - lexical state at the start of the line, from a prior call.
 * @returns { skeleton, state } — state is what the next line begins in.
 */
export function scanLine(line, state = { mode: 'code', stack: [] }) {
  let mode = state.mode;
  const stack = state.stack.map((frame) => ({ ...frame }));
  const top = () => (stack.length > 0 ? stack[stack.length - 1] : null);
  let out = '';
  let i = 0;
  // The text of each string literal, in the order the skeleton masks them.
  // The skeleton spends exactly `quote PROSE_MARK quote` on a string, so the
  // two line up positionally and {@link tokenizeSkeleton} can zip them back.
  const bodies = [];

  while (i < line.length) {
    const ch = line[i];
    const next = line[i + 1];

    if (mode === 'block') {
      if (ch === '*' && next === '/') { out += '*/'; mode = 'code'; i += 2; continue; }
      i += 1;
      continue;
    }

    if (mode === 'tpl') {
      if (ch === '\\') { i += 2; continue; }
      if (ch === '`') { out += '`'; stack.pop(); mode = 'code'; i += 1; continue; }
      // An interpolation is code again, and its contents matter.
      if (ch === '$' && next === '{') { out += '${'; stack.push({ kind: 'interp', depth: 0 }); mode = 'code'; i += 2; continue; }
      i += 1;
      continue;
    }

    if (ch === '/' && next === '/') { out += '//'; break; }
    if (ch === '/' && next === '*') { out += '/*'; mode = 'block'; i += 2; continue; }
    if (ch === '`') { out += '`'; stack.push({ kind: 'tpl' }); mode = 'tpl'; i += 1; continue; }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const bodyStart = i + 1;
      out += quote + PROSE_MARK;
      i += 1;
      while (i < line.length && line[i] !== quote) i += line[i] === '\\' ? 2 : 1;
      // An unterminated quote ends with the line rather than swallowing the
      // next, and contributes no token: the skeleton has no closing quote to
      // pair with, so recording a body here would shift every one after it.
      if (i < line.length) { bodies.push(line.slice(bodyStart, i)); out += quote; i += 1; }
      continue;
    }
    if (ch === '{' && top()?.kind === 'interp') { top().depth += 1; out += ch; i += 1; continue; }
    if (ch === '}' && top()?.kind === 'interp') {
      if (top().depth === 0) { stack.pop(); mode = 'tpl'; out += '}'; i += 1; continue; }
      top().depth -= 1;
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }

  return { skeleton: out, state: { mode, stack }, tokens: tokenizeSkeleton(out, bodies) };
}

/**
 * The lexical state each line of a file begins in, so {@link scanLine} can be
 * applied to any single line without re-reading the file ahead of it.
 * @param lines - the file's lines.
 * @returns one state per line, aligned by index.
 */
export function lineStates(lines) {
  const states = [];
  let state = { mode: 'code', stack: [] };
  for (const line of lines) {
    states.push(state);
    state = scanLine(line, state).state;
  }
  return states;
}

/** Extensions whose returned lines must keep their YAML structure intact. */
const YAML_EXTENSIONS = new Set(['.yml', '.yaml']);

/**
 * Read a YAML line as structure plus a list of quoted scalars.
 *
 * YAML needs its own reading because a plugin's `cordis.patch.yml` is boot
 * configuration, not copy. Nearly every token on a line is load-bearing —
 * indentation, the `-` list marker, the key, the row id — and a widened
 * writable window reaches these lines whenever a Chinese comment sits above
 * them. dsh-enhance's patch is three comment lines directly above
 * `- insert:`, so at radius 1 the insert row is handed to the model.
 *
 * The comment body is dropped, which leaves it free to be rewritten. Every
 * quoted scalar is lifted out so the caller can decide one at a time whether
 * it was prose or an identifier; an unquoted scalar stays in the skeleton and
 * is therefore locked.
 *
 * @param line - the line to read.
 * @returns { skeleton, scalars } — scalars in the order they appear.
 */
export function yamlScan(line) {
  let out = '';
  const scalars = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '#') { out += '#'; break; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === '\\' ? 2 : 1;
      const closed = j < line.length;
      scalars.push(line.slice(i + 1, Math.min(j, line.length)));
      out += ch + PROSE_MARK + (closed ? ch : '');
      i = closed ? j + 1 : line.length;
      continue;
    }
    out += ch;
    i += 1;
  }
  return { skeleton: out, scalars };
}

/**
 * Whether a rewritten YAML line kept everything that carries meaning to the
 * loader. The skeleton must match, and every quoted scalar must come back
 * byte-identical unless the original held CJK.
 *
 * That last clause is the line between the two things a quoted YAML value
 * tends to be: prose that came here to be translated, or an identifier like
 * `name: 'dsh-enhance'` that must survive exactly. Deciding from the original
 * rather than the replacement is what makes it work in one direction only —
 * Chinese may become English, English may not become anything else.
 */
function keepsYamlStructure(original, replacement) {
  const before = yamlScan(original);
  const after = yamlScan(replacement);
  if (before.skeleton !== after.skeleton) return false;
  if (before.scalars.length !== after.scalars.length) return false;
  return before.scalars.every((scalar, index) => hasCjk(scalar) || scalar === after.scalars[index]);
}

/**
 * Whether a replacement line differs from the original only in prose.
 * YAML is read by {@link yamlScan}, code by {@link scanLine}. Markdown and
 * the rest have no structure to preserve and always pass — their line-count
 * and indentation invariants are the guard there.
 *
 * @param original - the line as it was.
 * @param replacement - the line the model returned.
 * @param state - lexical state at the start of the line, from {@link lineStates}.
 * @param ext - the file's extension, lowercased, with the dot.
 */
export function keepsStructure(original, replacement, state, ext) {
  if (YAML_EXTENSIONS.has(ext)) return keepsYamlStructure(original, replacement);
  if (!STRUCTURED_EXTENSIONS.has(ext)) return true;
  return scanLine(original, state).skeleton === scanLine(replacement, state).skeleton;
}

/** Longest a dropped literal may be, trimmed, to still read as an affix. */
export const MAX_AFFIX_CHARS = 8;

/** Most affixes one line may shed. Two covers a circumfix on both sides. */
export const MAX_AFFIX_DROPS = 2;

/** Whether a token is a separator a dropped literal can take with it. */
function isJoiner(token) {
  return token.kind === 'code' && (token.text === ',' || token.text === '+');
}

/** Whether two tokens are the same as far as structure is concerned. */
function sameToken(a, b) {
  if (a.kind !== b.kind) return false;
  return a.kind === 'str' ? true : a.text === b.text;
}

/**
 * Whether a literal is short enough to be an affix rather than content.
 *
 * This is the line between "次" and a system prompt. Dropping an affix loses
 * a measure word English does not want; dropping content loses the thing the
 * program was there to say, and the gate must never mistake one for the other.
 */
function isAffix(token) {
  return token.kind === 'str' && token.cjk && token.text.trim().length <= MAX_AFFIX_CHARS;
}

/**
 * Whether a replacement differs from the original only by dropping Chinese
 * affixes, each with the one comma or `+` that joined it to its neighbour.
 *
 * Chinese wraps a number on both sides — 请求 N 次, 第 N 次请求 — where English
 * puts everything in front: "Requests N", "Request #N". Rendered through an
 * interpolation that is three arguments to `createElement` or three operands
 * of a `+` chain, and English needs two. No amount of rewording fixes that:
 * the trailing literal has nothing left to hold, so it has to go, and a gate
 * that compares whole skeletons calls its removal a structure change.
 *
 * So this is the one structural edit we allow, and it is bounded on every
 * side: deletion only, never insertion or substitution; only a string literal
 * that held CJK; only a short one, so a prompt or a sentence cannot vanish
 * this way; at most {@link MAX_AFFIX_DROPS} per line; and exactly one joiner
 * removed per literal, so `f(a, "次", b)` cannot come back as `f(a b)`. Every
 * code token that survives has to match, in order, byte for byte — the
 * identifiers, calls and operators are as untouchable as they ever were.
 *
 * @param original - the line as it was.
 * @param replacement - the line the model returned.
 * @param state - lexical state at the start of the line.
 */
export function dropsOnlyAffixes(original, replacement, state) {
  const before = scanLine(original, state).tokens;
  const after = scanLine(replacement, state).tokens;
  // Deletion only: a line that grew, or held its length, is not this case.
  if (after.length >= before.length) return false;
  if (before.length - after.length > MAX_AFFIX_DROPS * 2) return false;

  const visited = new Set();
  // `armed` means the token just dropped was an affix that has not yet taken
  // a joiner with it, which is what caps the removal at one joiner apiece.
  // `kept` means some Chinese literal on this line survived to be translated:
  // an affix is half of a construction, so the other half has to still be
  // here. Without it `t("中文标题", fallback)` -> `t(fallback)` reads as a
  // circumfix, when it is really a line quietly losing its only Chinese.
  const walk = (i, j, armed, drops, kept) => {
    if (i === before.length) return j === after.length && kept;
    if (drops > MAX_AFFIX_DROPS) return false;
    const key = `${i}:${j}:${armed ? 1 : 0}:${kept ? 1 : 0}`;
    if (visited.has(key)) return false;
    visited.add(key);
    if (j < after.length && sameToken(before[i], after[j])) {
      const survives = kept || (before[i].kind === 'str' && before[i].cjk);
      if (walk(i + 1, j + 1, false, drops, survives)) return true;
    }
    if (isAffix(before[i]) && walk(i + 1, j, true, drops + 1, kept)) return true;
    if (isJoiner(before[i])) {
      // The joiner behind the affix we just dropped...
      if (armed && walk(i + 1, j, false, drops, kept)) return true;
      // ...or the one in front of the affix we are about to.
      if (i + 1 < before.length && isAffix(before[i + 1]) && walk(i + 2, j, false, drops + 1, kept)) return true;
    }
    return false;
  };
  return walk(0, 0, false, 0, false);
}

/**
 * How a replacement line may be accepted, if at all.
 *
 * `strict` is a prose-only rewrite and is what almost every line returns.
 * `affix` is the narrow exemption in {@link dropsOnlyAffixes}, offered only
 * to a line that actually held Chinese — the margin around it is there to be
 * reworded, never to be shortened. `false` keeps the original line.
 *
 * @returns 'strict' | 'affix' | false
 */
export function checkLine(original, replacement, state, ext) {
  if (keepsStructure(original, replacement, state, ext)) return 'strict';
  if (!STRUCTURED_EXTENSIONS.has(ext) || !hasCjk(original)) return false;
  return dropsOnlyAffixes(original, replacement, state) ? 'affix' : false;
}

/**
 * Extract a JSON object from a model reply, tolerating a code fence and any
 * prose either side of it.
 * @param text - the raw reply.
 * @returns the parsed object, or undefined when nothing parses.
 */
export function parseJsonReply(text) {
  const candidates = [];
  const unfenced = stripCodeFence(String(text ?? ''), '.json').trim();
  if (unfenced.length > 0) candidates.push(unfenced);
  const first = unfenced.indexOf('{');
  const last = unfenced.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(unfenced.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object') return parsed;
    } catch { /* try the next candidate */ }
  }
  return undefined;
}

/**
 * Check that a rebuilt file still parses. JSON is parsed directly; JavaScript
 * goes through `node --check` on a sibling temp file, so the package's own
 * `type` field decides script-vs-module exactly as it will at load time.
 * Anything else (Markdown, YAML, TypeScript) is written unvalidated — the
 * line-count and indentation invariants are the guard there.
 * @param filePath - the real path the text is destined for.
 * @param text - the rebuilt content.
 * @returns { checked, ok, error }
 */
export function validateSyntax(filePath, text) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(text);
      return { checked: true, ok: true };
    } catch (error) {
      return { checked: true, ok: false, error: `invalid JSON: ${error?.message ?? String(error)}` };
    }
  }
  if (!NODE_CHECKABLE.has(ext)) return { checked: false, ok: true };
  const probe = join(dirname(filePath), `${basename(filePath, ext)}.dsh-to-english-check${ext}`);
  try {
    writeFileSync(probe, text, 'utf8');
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
    return { checked: true, ok: true };
  } catch (error) {
    const detail = error?.stderr?.toString?.() ?? error?.message ?? String(error);
    return { checked: true, ok: false, error: `syntax check failed: ${detail.split('\n').slice(0, 3).join(' ').trim()}` };
  } finally {
    try { unlinkSync(probe); } catch { /* the probe may never have been written */ }
  }
}

/**
 * Pick the provider/model to use.
 *
 * A configured selection is taken at its word. With nothing configured we
 * cannot simply take the first provider the service lists: `listProviders()`
 * reports every registered route whether or not it has usable credentials,
 * and the first one here is `deepseek-official`, which has none. Picking it
 * meant every file failed and the report said only "failed", which is how a
 * whole run translated nothing while looking merely unlucky. So an
 * unconfigured selection probes candidates with a one-token request and takes
 * the first that actually answers.
 *
 * @param llm - the live `llm` service.
 * @param configured - { provider, model } from settings.
 * @param signal - optional AbortSignal.
 * @returns { provider, model, probed } or null when nothing is usable.
 */
export async function resolveModel(llm, configured, signal) {
  if (!llm) return null;
  let providers;
  try {
    providers = await llm.listProviders();
  } catch {
    return null;
  }
  if (!Array.isArray(providers) || providers.length === 0) return null;

  const pick = async (providerId, modelId) => {
    if (!providerId) return null;
    let models;
    try {
      models = await llm.listModels(providerId);
    } catch {
      return null;
    }
    if (!Array.isArray(models) || models.length === 0) return null;
    const chosen = modelId ? models.find((m) => m.id === modelId) : models[0];
    if (!chosen) return null;
    return { provider: providerId, model: chosen.id };
  };

  // An explicit choice is the user's to make, including a wrong one: a failed
  // request says so far more clearly than silently using something else.
  if (configured?.provider) {
    const exact = await pick(configured.provider, configured.model);
    if (exact) return { ...exact, probed: false };
  }

  for (const provider of providers) {
    const candidate = await pick(provider.id, '');
    if (!candidate) continue;
    if (await probeSelection(llm, candidate, signal)) return { ...candidate, probed: true };
  }
  return null;
}

/**
 * Ask a candidate provider/model for a single token. Cheap enough to run over
 * every provider, and the only way to tell a configured route from a usable
 * one.
 * @returns true when the route answered without erroring.
 */
export async function probeSelection(llm, selection, signal) {
  try {
    for await (const chunk of llm.stream({
      provider: selection.provider,
      model: selection.model,
      messages: [createUserMessage({ content: [{ type: 'text', text: 'ok' }] })],
      maxTokens: 4,
      temperature: 0,
      signal,
    })) {
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The mechanical half of the instructions, which the user's editable prompt
 * must not be able to break. The editable prompt is style guidance appended
 * to this; the protocol below is what keeps the output spliceable.
 */
const PROTOCOL_RULES = [
  'You are a translation engine that rewrites Chinese text inside source files as English.',
  '',
  'Each request has two parts. First the whole file, line-numbered, as READ-ONLY context: it is there so you can see what the code does and how a term is used elsewhere in it. You never return it and you never quote it back. Second, a JSON request naming the only lines you may rewrite:',
  '  { "file": "<path>", "segments": [ { "id": <n>, "startLine": <n>, "before": [...], "lines": [...], "after": [...] } ] }',
  '',
  '"lines" is the writable set, and "startLine" is where it begins in the numbered file. "before" and "after" are the lines either side, given for meaning only — never translate them, never return them.',
  '',
  'Reply with JSON and nothing else:',
  '  { "segments": [ { "id": <n>, "lines": [...] } ] }',
  '',
  'Hard rules, in order of importance:',
  '1. Return exactly as many lines as you were given for each segment, in the same order. Never merge, split, add, or drop a line. A one-line segment returns exactly one line.',
  '2. Change prose, never structure. Prose is the text of a comment and the human-facing content of a string literal. Structure is everything else: identifiers, keywords, operators, quotes, brackets, commas, indentation, URLs, file paths, object keys, error codes, YAML keys, Markdown syntax, and the code inside a template interpolation. Structure is copied through byte for byte on every line. A writable line that holds no prose at all is returned exactly as it was given.',
  '3. On a line that contains CJK, replace the CJK with English.',
  '4. The writable set reaches a line or two past the Chinese on purpose. Where a sentence is split across lines, or a comment mixes both languages, rewrite the English in that margin so the passage reads as one thought instead of a translation grafted onto an English fragment. Do not read the margin as licence to improve code, rename anything, or reword prose that has nothing to do with the Chinese beside it.',
  '5. Some Chinese is not copy: it is data the program acts on. Return such a line completely unchanged. This covers any string the code matches user input against (trigger phrases, keywords, patterns) and any string sent to another system as part of a protocol (an embedding model\'s instruction prefix, an API constant). Ask what breaks if the characters change: if the answer is behaviour rather than readability, leave it alone.',
  '6. A comment or a document that quotes Chinese as an example of input the code recognizes is describing a literal the code still matches. Keep the Chinese exactly as it stands and add a short English gloss after it, so the line reads in English without becoming untrue: ("继续" — continue). Never replace the example.',
  '7. Chinese wraps a number on both sides where English puts everything in front: 请求 N 次 is "Requests N", 第 N 次请求 is "Request #N". When the halves are separate string literals either side of an interpolation, translate the leading one and delete the trailing one outright, along with the single comma or + that joined it. Deleting a literal is allowed only for this: only a short one, only when the other half of the pair stays, and never a whole phrase, a prompt, or an argument the code reads.',
  '8. Preserve each line\'s original leading whitespace.',
  '9. Do not comment on your work, do not explain, do not wrap the JSON in a code fence.',
];

/**
 * The rules that only exist to keep Chinese working, and their inversion.
 *
 * Rules 5 and 6 tell the model to leave alone the Chinese a program matches
 * on, and to keep a Chinese example a comment is explaining. Both are correct
 * when the plugin has to go on serving Chinese users. On an English-only
 * install they are how a feature ends up switched off: dsh-recall ships 95
 * trigger words and 14 process patterns, none of which hold a single ASCII
 * letter, so its auto-recall gate cannot fire for an English speaker at all.
 * Translating that data is not damage — it is the point.
 */
const FUNCTIONAL_RULES = ['5.', '6.'];

const BLUNT_RULES = [
  '5. Translate every Chinese string, with no exception for strings the program acts on: trigger phrases, keyword lists, the contents of a regex, the non-English half of a locale table. This install serves English only, so a Chinese literal that stops matching Chinese input is the intended result — it is being replaced by one that matches English input instead. Translate the CJK inside a regex literal in place, leaving every anchor, class, quantifier and delimiter exactly as it is.',
  '6. Where a comment quotes Chinese as an example of input the code recognizes, translate the example to the English the code will now recognize, so comment and behaviour still agree.',
];

/**
 * The system contract sent with every request.
 * @param translateEverything - drop the rules that preserve Chinese behaviour.
 */
export function protocolSystem(translateEverything = false) {
  if (!translateEverything) return PROTOCOL_RULES.join('\n');
  // Swapped in place by rule number rather than by index, so inserting a rule
  // above them cannot silently start replacing the wrong two.
  const swapped = PROTOCOL_RULES.map((rule) => {
    const hit = FUNCTIONAL_RULES.indexOf(rule.slice(0, 2));
    return hit === -1 ? rule : BLUNT_RULES[hit];
  });
  if (!swapped.includes(BLUNT_RULES[0]) || !swapped.includes(BLUNT_RULES[1])) {
    throw new Error('protocolSystem: the rules it replaces have been renumbered');
  }
  return swapped.join('\n');
}

/** The careful contract, kept for callers that do not pass a mode. */
export const PROTOCOL_SYSTEM = protocolSystem(false);

/**
 * The whole file, line-numbered, as read-only context.
 *
 * This is the half of "just send the model the whole script" worth keeping.
 * Comprehension and write scope are separable: reading the file is what lets
 * the model see that a string sits in a `zh` table beside an `en` one, or that
 * a constant is handed to an embedder, while the writable set stays small
 * enough that the rest of the file cannot come back changed. A file too large
 * to carry falls back to the per-segment before/after lines alone.
 */
function fileContext(lines) {
  const size = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (size > MAX_CONTEXT_CHARS) return '';
  const width = String(lines.length).length;
  const numbered = lines.map((line, index) => `${String(index + 1).padStart(width, ' ')}| ${line}`).join('\n');
  return `WHOLE FILE — read-only context, ${lines.length} line(s):\n${numbered}\n\n`;
}

/**
 * Translate one batch of segments through the model.
 * @param llm - the live `llm` service.
 * @param selection - { provider, model } from resolveModel.
 * @param styleGuide - the user-editable prompt, appended to the protocol.
 * @param relPath - the file's path relative to the package, for context.
 * @param lines - the file's lines.
 * @param batch - segments from {@link segmentBatches}.
 * @param signal - optional AbortSignal.
 * @param states - per-line lexical state from {@link lineStates}.
 * @returns Map of line index to replacement text, for accepted lines only.
 */
export async function translateBatch(llm, selection, styleGuide, relPath, lines, batch, signal, states, translateEverything = false) {
  const ext = extname(relPath).toLowerCase();
  const stateOf = states ?? lineStates(lines);
  const payload = {
    file: relPath,
    segments: batch.map((segment) => ({
      id: segment.id,
      startLine: segment.start + 1,
      before: lines.slice(Math.max(0, segment.start - CONTEXT_LINES), segment.start),
      lines: lines.slice(segment.start, segment.end + 1),
      after: lines.slice(segment.end + 1, segment.end + 1 + CONTEXT_LINES),
    })),
  };
  const body = `${fileContext(lines)}REQUEST:\n${JSON.stringify(payload, null, 2)}`;
  const system = styleGuide ? `${protocolSystem(translateEverything)}\n\nStyle guidance for the English you produce:\n${styleGuide}` : protocolSystem(translateEverything);

  // Sized from the writable lines alone. The file context dwarfs them and is
  // never echoed back, so budgeting against the whole message would ask for a
  // completion far larger than the model will ever be asked to produce.
  let writableChars = 0;
  for (const segment of batch) {
    for (let i = segment.start; i <= segment.end; i += 1) writableChars += lines[i].length + 1;
  }
  const maxTokens = Math.min(16000, Math.max(2000, writableChars + 1500));

  const messages = [createUserMessage({ content: [{ type: 'text', text: body }] })];
  let reply = await streamText(llm, selection, system, messages, maxTokens, signal);
  let parsed = parseJsonReply(reply);
  if (parsed === undefined) {
    // One corrective round-trip. Models that ignore "JSON only" the first time
    // usually comply when the failure is quoted back at them.
    messages.push(createUserMessage({ content: [{ type: 'text', text: 'That reply was not valid JSON. Reply again with only the JSON object described, no prose and no code fence.' }] }));
    reply = await streamText(llm, selection, system, messages, maxTokens, signal);
    parsed = parseJsonReply(reply);
  }
  if (parsed === undefined) throw new Error('model did not return parseable JSON');

  const returned = new Map();
  for (const segment of Array.isArray(parsed.segments) ? parsed.segments : []) {
    if (typeof segment?.id === 'number' && Array.isArray(segment.lines)) returned.set(segment.id, segment.lines);
  }

  const replacements = new Map();
  const rejected = [];
  const relaxed = [];
  for (const segment of batch) {
    const produced = returned.get(segment.id);
    const expected = segment.end - segment.start + 1;
    if (!Array.isArray(produced)) {
      rejected.push(`segment ${segment.id}: missing from reply`);
      continue;
    }
    if (produced.length !== expected) {
      // The one invariant we refuse to repair: a different line count means
      // we no longer know which output belongs to which input.
      rejected.push(`segment ${segment.id}: expected ${expected} line(s), got ${produced.length}`);
      continue;
    }
    for (let offset = 0; offset < expected; offset += 1) {
      const index = segment.start + offset;
      const value = produced[offset];
      if (typeof value !== 'string' || value.includes('\n')) {
        rejected.push(`segment ${segment.id}: line ${index + 1} is not a single line`);
        continue;
      }
      const candidate = reindent(lines[index], value);
      const verdict = checkLine(lines[index], candidate, stateOf[index], ext);
      if (!verdict) {
        // Rejected one line, not the segment: the rest of the passage is
        // still good, and this line simply stays as it was.
        rejected.push(`segment ${segment.id}: line ${index + 1} changed code structure, kept the original`);
        continue;
      }
      if (verdict === 'affix') {
        // Accepted, but surfaced: this is the one edit that changes the shape
        // of a line, and it is worth a human eye on the diff.
        relaxed.push(`${relPath}:${index + 1}: dropped a Chinese affix and its joiner`);
      }
      replacements.set(index, candidate);
    }
  }
  return { replacements, rejected, relaxed };
}

/** Collect a streamed completion into a string, surfacing provider errors. */
async function streamText(llm, selection, system, messages, maxTokens, signal) {
  let out = '';
  for await (const chunk of llm.stream({
    provider: selection.provider,
    model: selection.model,
    system,
    messages,
    maxTokens,
    temperature: 0,
    signal,
  })) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
    else if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
      throw new Error(`translation model error: ${chunk.reason.message ?? 'unknown'}`);
    }
  }
  return out;
}

/**
 * Translate one file in place, or explain why it was left alone.
 * @returns a per-file report; `status` is one of translated, unchanged,
 *          too-large, invalid, failed.
 */
export async function translateFile(llm, selection, styleGuide, packageDir, file, signal, rewriteRadius = DEFAULT_REWRITE_RADIUS, translateEverything = false) {
  const rel = relative(packageDir, file);
  const report = { file: rel, status: 'unchanged', segments: 0, replaced: 0, cjkBefore: 0, cjkAfter: 0 };

  let size;
  try {
    size = statSync(file).size;
  } catch (error) {
    return { ...report, status: 'failed', error: `stat failed: ${error?.message ?? String(error)}` };
  }
  if (size > MAX_FILE_BYTES) {
    return { ...report, status: 'too-large', error: `${size} bytes exceeds the ${MAX_FILE_BYTES}-byte cap` };
  }

  const original = readFileSync(file, 'utf8');
  report.cjkBefore = countCjk(original);
  const { lines, eol, trailingNewline } = splitLines(original);
  const segments = findCjkSegments(lines, MAX_SEGMENT_LINES, extname(file).toLowerCase(), rewriteRadius, !translateEverything);
  report.segments = segments.length;
  if (segments.length === 0) return { ...report, cjkAfter: report.cjkBefore };

  // Scanned once for the file, not once per batch: the state a line starts in
  // depends on every line before it.
  const states = lineStates(lines);
  const replacements = new Map();
  const rejected = [];
  const relaxed = [];
  for (const batch of segmentBatches(lines, segments)) {
    if (signal?.aborted) break;
    const result = await translateBatch(llm, selection, styleGuide, rel, lines, batch, signal, states, translateEverything);
    for (const [index, value] of result.replacements) replacements.set(index, value);
    rejected.push(...result.rejected);
    relaxed.push(...result.relaxed);
  }
  if (replacements.size === 0) {
    return { ...report, status: 'failed', cjkAfter: report.cjkBefore, error: rejected[0] ?? 'model returned no usable lines' };
  }

  // A widened window hands back lines that were already English and came back
  // untouched. They are accepted, but they are not changes — counting them as
  // such would report a six-line rewrite where one line moved.
  const rebuilt = lines.slice();
  let changed = 0;
  for (const [index, value] of replacements) {
    if (value !== lines[index]) changed += 1;
    rebuilt[index] = value;
  }
  const text = joinLines(rebuilt, eol, trailingNewline);
  if (text === original) return { ...report, cjkAfter: report.cjkBefore, ...(rejected.length > 0 ? { rejected } : {}), ...(relaxed.length > 0 ? { relaxed } : {}) };

  const syntax = validateSyntax(file, text);
  if (!syntax.ok) {
    return { ...report, status: 'invalid', cjkAfter: report.cjkBefore, error: syntax.error };
  }

  // Keep the first backup only: a second pass must not overwrite the original
  // Chinese with the English of the pass before it.
  const backup = `${file}${BACKUP_SUFFIX}`;
  if (!existsSync(backup)) copyFileSync(file, backup);
  writeFileSync(file, text, 'utf8');

  return {
    ...report,
    status: 'translated',
    replaced: changed,
    accepted: replacements.size,
    cjkAfter: countCjk(text),
    checked: syntax.checked,
    backup: `${rel}${BACKUP_SUFFIX}`,
    ...(rejected.length > 0 ? { rejected } : {}),
    ...(relaxed.length > 0 ? { relaxed } : {}),
  };
}

/**
 * Translate a whole installed plugin package in place.
 * @param ctx - host context (for the `llm` service and logger).
 * @param packageDir - absolute path to the installed package.
 * @param config - resolved plugin config (enabled, provider, model, prompt).
 * @param signal - optional AbortSignal.
 * @param onProgress - optional (done, total, file) callback for live status.
 * @returns a report of what happened.
 */
export async function translatePackage(ctx, packageDir, config, signal, onProgress) {
  if (config?.enabled === false) return { status: 'disabled' };
  const llm = ctx.get?.('llm', false);
  if (!llm) return { status: 'no-llm' };

  const selection = await resolveModel(llm, { provider: config?.provider, model: config?.model }, signal);
  if (!selection) {
    return { status: 'no-model', error: 'no configured provider answered a probe request' };
  }

  const files = listTranslatableFiles(packageDir).filter((f) => {
    try {
      return hasCjk(readFileSync(f, 'utf8'));
    } catch {
      return false;
    }
  });
  if (files.length === 0) return { status: 'no-cjk', selection, files: [] };

  const styleGuide = config?.prompt?.trim() || undefined;
  const rewriteRadius = clampRadius(config?.rewriteRadius);
  const translateEverything = config?.translateEverything !== false;
  const reports = [];
  const translated = [];
  const failed = [];
  const errors = [];

  for (const [index, file] of files.entries()) {
    if (signal?.aborted) break;
    onProgress?.(index, files.length, relative(packageDir, file));
    let report;
    try {
      report = await translateFile(llm, selection, styleGuide, packageDir, file, signal, rewriteRadius, translateEverything);
    } catch (error) {
      report = { file: relative(packageDir, file), status: 'failed', error: error?.message ?? String(error) };
    }
    reports.push(report);
    // The affix exemption is the only edit that changes a line's shape, so it
    // is logged even on success — nothing else here is worth re-reading.
    for (const note of report.relaxed ?? []) ctx.logger?.info?.(`[dsh-to-english] ${note}`);
    if (report.status === 'translated') translated.push(report.file);
    else if (report.status !== 'unchanged') {
      failed.push(report.file);
      errors.push({ file: report.file, status: report.status, message: report.error ?? 'unknown' });
      ctx.logger?.warn?.(`[dsh-to-english] ${report.file}: ${report.status} — ${report.error ?? 'unknown'}`);
    }
  }

  return {
    status: 'done',
    selection,
    rewriteRadius,
    translateEverything,
    files: reports,
    translated,
    failed,
    errors,
    cjkRemaining: reports.reduce((sum, r) => sum + (r.cjkAfter ?? 0), 0),
  };
}

/**
 * The model sometimes wraps output in a markdown code fence even when told
 * not to. Strip a single outer fence matching the file's language.
 */
export function stripCodeFence(text, ext) {
  const trimmed = text.trimStart();
  const fence = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(trimmed);
  if (fence) return fence[1];
  return text;
}

/** Whether a package dir exists and has a package.json (i.e. is installed). */
export function isInstalledPackage(packageDir) {
  return existsSync(join(packageDir, 'package.json'));
}

/** Basename of a path (used for logging). */
export function baseName(p) {
  return basename(p);
}
