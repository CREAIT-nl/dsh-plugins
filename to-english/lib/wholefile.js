/**
 * wholefile.js — hand the model an entire file, take an entire file back, and
 * let a compiler decide whether the result is acceptable.
 *
 * The other path in this plugin (`translateFile` in translate.js) sends line
 * ranges and refuses any reply that changes a line's code skeleton. That gate
 * is safe and it is also why Chinese that has to change *shape* to become
 * English never translates: `/^[好嗯啊]*\s*继续/` has to become
 * `/^(ok|um|ah)*\s*continue/`, a character class turning into an alternation,
 * because Chinese marks optionality per character and English words are longer
 * than one character. Every such line came back rejected.
 *
 * So this path drops the skeleton comparison entirely. The model rewrites the
 * whole file however it needs to, and the only thing standing behind it is a
 * deterministic check that the file still parses — fed back into the
 * conversation on failure so the model repairs its own output.
 *
 * What that trades away is real and worth stating: `node --check` catches a
 * file that stopped parsing, not one that still parses and now means something
 * else. A renamed identifier, a reworded `id:` in cordis.patch.yml, a
 * translated `"main"` in package.json all survive their parser. The contract
 * below asks the model to leave those alone; nothing here enforces it.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { BACKUP_SUFFIX, countCjk, splitLines, stripCodeFence, streamText } from './translate.js';

/**
 * Largest file handed over whole. The model has to echo every byte back, so
 * the ceiling here is really the completion budget, not the context window.
 * Above this the caller falls back to the segment path.
 */
export const WHOLE_FILE_MAX_BYTES = 48 * 1024;

/** How many repair round-trips a failing file gets before it is abandoned. */
export const MAX_REPAIR_ATTEMPTS = 3;

/**
 * A reply shorter than this fraction of the original is treated as truncated
 * rather than as a translation. Prose files have no parser to catch a cut-off
 * completion, and a half-written README is worse than an untouched one.
 */
const MIN_LENGTH_RATIO = 0.6;

/** Extensions `node --check` can parse. */
const NODE_CHECKABLE = new Set(['.js', '.cjs', '.mjs']);

/** Extensions parsed as YAML, when a parser is available. */
const YAML_EXTENSIONS = new Set(['.yml', '.yaml']);

/**
 * The mechanical contract. Style guidance is appended by the caller and can be
 * edited in settings; this part cannot.
 */
export const WHOLE_FILE_RULES = [
  'You are translating one source file of a DeepSeek Harness plugin from Chinese into English. You are given the complete file. Return the complete file.',
  '',
  '1. Reply with the file content and nothing else: no preamble, no explanation, no markdown code fence.',
  '2. Translate every piece of Chinese in the file into English — comments, UI strings, log messages, prompts, documentation, and equally the Chinese the program itself matches on: trigger phrases, keyword lists, and the contents of regular expressions. This install serves English only. A Chinese literal that stops matching Chinese input is the intended outcome; it is being replaced by one that matches English input instead.',
  '3. Where Chinese has to change shape to become English, change the shape. Chinese marks optionality one character at a time, so a pattern like /^[好嗯啊]*\\s*继续/ becomes /^(ok|um|ah)*\\s*continue/ and /^我们?继续/ becomes /^(i|we)\\s+continue/. Group what the quantifier is meant to cover: /^我?重启了/ becomes /^(i )?restarted/, never /^i? restarted/, which would require the space. Keep the regular expression valid and keep its anchors and delimiters. Where a Chinese phrase list collapses onto one English phrase, keep one entry rather than repeating it.',
  '4. Do not rename anything the program refers to by name: variable and function names, object keys, import and require paths, URL and route paths, settings namespaces, package names, and the `id`, `name`, and `main` fields of package.json and cordis.patch.yml. Translate the values a human reads, not the keys the code looks up.',
  '5. Leave a string alone when it is addressed to a machine rather than a person and its exact bytes matter — a wire protocol token, a magic value compared elsewhere, and in particular an embedding model\'s instruction prefix. That prefix belongs to the checkpoint, not to the user: a model trained on Chinese instructions expects its Chinese instruction whatever language the query is in, so leave it exactly as it is even when the rest of the file becomes English, and do not substitute the same model family\'s English prefix. When you leave Chinese in place for this reason, leave it silently; do not add a note.',
  '6. Preserve the file\'s indentation style, quoting style, trailing newline, and license or attribution headers. Do not reformat code you are not translating, and do not add or remove imports.',
  '7. Where a comment quotes Chinese as an example of input the code recognizes, translate the example to the English the code now recognizes, so the comment and the behaviour still agree.',
  '8. Chinese has no letter case, so a pattern or comparison that matched Chinese never needed to account for it and its English replacement does. Unless the surrounding code already lowercases the input, add the `i` flag to a regular expression you translate, and compare case-insensitively where a bare equality would now depend on how the user capitalised a word.',
].join('\n');

/**
 * Parse-check a candidate file body.
 *
 * JavaScript goes through `node --check` on a sibling temp file, so the
 * package's own `type` field decides script-vs-module exactly as it will at
 * load time. JSON and YAML are parsed. Anything else has no parser and is
 * reported unchecked rather than pretended-valid.
 *
 * @param filePath - the real path the text is destined for.
 * @param text - the candidate content.
 * @returns { checked, ok, error }
 */
export function lintText(filePath, text) {
  const ext = extname(filePath).toLowerCase();

  if (ext === '.json') {
    try {
      JSON.parse(text);
      return { checked: true, ok: true };
    } catch (error) {
      return { checked: true, ok: false, error: `invalid JSON: ${error?.message ?? String(error)}` };
    }
  }

  if (YAML_EXTENSIONS.has(ext)) {
    const yaml = loadYamlParser();
    // No parser is a reason to say so, not a reason to claim the file is fine.
    if (yaml === undefined) return { checked: false, ok: true };
    try {
      yaml.load(text);
      return { checked: true, ok: true };
    } catch (error) {
      return { checked: true, ok: false, error: `invalid YAML: ${error?.message ?? String(error)}` };
    }
  }

  if (!NODE_CHECKABLE.has(ext)) return { checked: false, ok: true };

  // The probe extension is resolved, never inherited. `node --check` on an
  // ambiguous `.js` — one whose package declares no `type` — exits 0 on source
  // that does not parse: it fails the CommonJS parse, recognises `export` as
  // ESM syntax, and the retry swallows the error. `export const a = (1` passes.
  // Naming the probe `.mjs`/`.cjs` removes the ambiguity, so the check either
  // reports a real result or reports nothing.
  const probe = join(dirname(filePath), `${basename(filePath, ext)}.dsh-to-english-check${probeExtension(filePath)}`);
  try {
    writeFileSync(probe, text, 'utf8');
  } catch (error) {
    // Nothing was parsed, so nothing may be claimed. Saying "invalid" here
    // would send the model off to repair a file that was never broken.
    return { checked: false, ok: true, skipped: `probe write failed: ${error?.message ?? String(error)}` };
  }
  try {
    execFileSync(process.execPath, ['--check', probe], { stdio: 'pipe' });
    return { checked: true, ok: true };
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? '';
    return { checked: true, ok: false, error: cleanNodeError(stderr, probe) || (error?.message ?? String(error)) };
  } finally {
    try { unlinkSync(probe); } catch { /* already gone */ }
  }
}

/**
 * The extension that makes `node --check` unambiguous for this file: the one
 * it already carries when that settles the question, otherwise the one its
 * package's `type` field implies.
 */
export function probeExtension(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.mjs' || ext === '.cjs') return ext;
  return packageType(dirname(filePath)) === 'module' ? '.mjs' : '.cjs';
}

/** Nearest enclosing package.json's `type`, defaulting as Node does. */
export function packageType(dir) {
  let current = dir;
  for (let depth = 0; depth < 16; depth += 1) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        return JSON.parse(readFileSync(manifest, 'utf8'))?.type === 'module' ? 'module' : 'commonjs';
      } catch {
        return 'commonjs';
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return 'commonjs';
}

/** Resolved once; `undefined` means this install has no YAML parser. */
let yamlParser;
let yamlParserResolved = false;

/**
 * js-yaml is optional and deliberately not a dependency of this plugin: it is
 * already present in every harness that loads us, and adding it would mean a
 * `pnpm install` against a link:'d workspace package — the one operation that
 * has already cost this profile its node_modules once. So it is looked up
 * from the plugin, then from the host process, and YAML simply goes unchecked
 * where neither answers.
 */
function loadYamlParser() {
  if (yamlParserResolved) return yamlParser;
  yamlParserResolved = true;
  const roots = [import.meta.url, process.argv[1], join(process.cwd(), 'x.js')].filter(Boolean);
  for (const root of roots) {
    try {
      yamlParser = createRequire(root)('js-yaml');
      return yamlParser;
    } catch { /* try the next root */ }
  }
  yamlParser = undefined;
  return yamlParser;
}

/**
 * `node --check` reports against the temp probe path and prints a banner and a
 * stack. The model only needs the file-relative line and the message.
 */
export function cleanNodeError(stderr, probePath) {
  const wanted = [];
  for (const line of String(stderr).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (line.startsWith('    at ') || line.startsWith('Node.js v')) continue;
    wanted.push(line.replace(probePath, basename(probePath)));
    if (wanted.length >= 6) break;
  }
  return wanted.join('\n').trim();
}

/**
 * Whether a reply is short enough that the completion was probably cut off.
 * Only meaningful as a floor — a translation genuinely shrinks, since English
 * spends more characters per word but Chinese spends more bytes per character.
 */
export function looksTruncated(original, produced) {
  if (produced.trim() === '') return true;
  return produced.length < original.length * MIN_LENGTH_RATIO;
}

/**
 * Translate one file by handing the model the whole thing.
 *
 * @param llm - the llm service.
 * @param selection - { provider, model }.
 * @param styleGuide - the user's editable prompt, or undefined.
 * @param packageDir - package root, for relative paths in the report.
 * @param file - absolute path of the file to translate.
 * @param signal - optional AbortSignal.
 * @param maxAttempts - repair round-trips allowed.
 * @returns a per-file report; `status` is translated, unchanged, invalid or failed.
 */
export async function translateWholeFile(llm, selection, styleGuide, packageDir, file, signal, maxAttempts = MAX_REPAIR_ATTEMPTS) {
  const rel = relative(packageDir, file);
  const original = readFileSync(file, 'utf8');
  const report = { file: rel, status: 'unchanged', mode: 'whole-file', attempts: 0, cjkBefore: countCjk(original), cjkAfter: 0 };

  const ext = extname(file).toLowerCase();
  // The path goes in the system prompt, never in the user message. Prefixing
  // the content with a `FILE: <path>` header cost two of dsh-recall's five
  // files a literal `FILE: lib/semantic.js` as their first line — and
  // `node --check` accepted it, because that parses as a labelled statement
  // dividing three identifiers. Nothing is safe to put next to the content.
  const system = [
    WHOLE_FILE_RULES,
    `\nThe file you are translating is ${rel}. Do not write its path, or any header, label or fence, into your reply: the reply is written to disk verbatim as the new content of that file.`,
    ...(styleGuide ? [`\nStyle guidance for the English you produce:\n${styleGuide}`] : []),
  ].join('\n');

  // Sized against the input: the model is echoing the file back, and English
  // runs longer than the Chinese it replaces.
  const maxTokens = Math.min(32000, Math.max(2000, Math.ceil(original.length / 2) + 2000));

  const messages = [createUserMessage({ content: [{ type: 'text', text: original }] })];
  const problems = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) return { ...report, status: 'failed', attempts: attempt - 1, error: 'aborted' };
    report.attempts = attempt;

    const reply = await streamText(llm, selection, system, messages, maxTokens, signal);
    const candidate = normalizeEol(stripCodeFence(reply, ext), original);

    let problem;
    let lint = { checked: false, ok: true };
    const envelope = leakedEnvelope(original, candidate);
    if (envelope !== undefined) {
      problem = `the reply opens with ${JSON.stringify(envelope)}, which is not part of the file. Return the file content only.`;
    } else if (looksTruncated(original, candidate)) {
      problem = `the reply was ${candidate.length} characters against an original of ${original.length}; it looks truncated. Return the complete file.`;
    } else {
      lint = lintText(file, candidate);
      if (!lint.ok) problem = `the file no longer parses:\n${lint.error}`;
    }

    if (problem === undefined) {
      if (candidate === original) return { ...report, cjkAfter: report.cjkBefore, ...(problems.length > 0 ? { repaired: problems } : {}) };
      const backup = `${file}${BACKUP_SUFFIX}`;
      // Keep the first backup only: a second pass must not overwrite the
      // original Chinese with the English of the pass before it.
      if (!existsSync(backup)) copyFileSync(file, backup);
      writeFileSync(file, candidate, 'utf8');
      return {
        ...report,
        status: 'translated',
        cjkAfter: countCjk(candidate),
        checked: lint.checked,
        backup: `${rel}${BACKUP_SUFFIX}`,
        ...(problems.length > 0 ? { repaired: problems } : {}),
      };
    }

    problems.push(`attempt ${attempt}: ${problem.split('\n')[0]}`);
    messages.push(createUserMessage({ content: [{ type: 'text', text: reply }] }));
    messages.push(createUserMessage({
      content: [{ type: 'text', text: `That output was rejected: ${problem}\n\nReturn the complete corrected file, content only, no code fence.` }],
    }));
  }

  return { ...report, status: 'invalid', cjkAfter: report.cjkBefore, error: problems[problems.length - 1] ?? 'no usable reply', repaired: problems };
}

/**
 * The first line of a reply, when it is an envelope the model wrote around the
 * file rather than a line of the file.
 *
 * Worth checking separately because no parser will object: `FILE: lib/x.js` is
 * a labelled statement dividing identifiers, and `node --check` passes it. The
 * test is deliberately narrow — a `label:`-shaped or `FILE:`-shaped opening
 * line that the original did not have — so a file that genuinely starts with a
 * label is left alone.
 *
 * @returns the offending line, or undefined.
 */
export function leakedEnvelope(original, produced) {
  const first = produced.split(/\r?\n/, 1)[0] ?? '';
  if (first.trim() === '') return undefined;
  const originalFirst = original.split(/\r?\n/, 1)[0] ?? '';
  if (first === originalFirst) return undefined;
  if (/^\s*(FILE|PATH|FILENAME)\s*:/i.test(first)) return first.trim();
  // `Here is the translated file:` and friends.
  if (/^\s*(here('s| is)|below is|the (translated|corrected))\b/i.test(first)) return first.trim();
  return undefined;
}

/**
 * Match the original's line ending and trailing-newline habit. Models
 * normalize to LF and drop the final newline; neither is a translation.
 */
export function normalizeEol(text, original) {
  const { eol, trailingNewline } = splitLines(original);
  let out = text.replace(/\r\n/g, '\n');
  if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
  const ends = out.endsWith(eol);
  if (trailingNewline && !ends) out += eol;
  if (!trailingNewline && ends) out = out.slice(0, -eol.length);
  return out;
}
