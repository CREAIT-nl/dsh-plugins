#!/usr/bin/env node
// Publish every public workspace package whose version is not on the registry yet.
//
// The registry is the state, so this is idempotent: running it with nothing
// bumped publishes nothing. That is what makes a manual "Run workflow" button
// safe to press without first working out which packages changed.
//
//   node scripts/publish-changed.mjs --dry-run   # plan only, no writes
//   node scripts/publish-changed.mjs --tag       # also create name@version git tags

import { execFileSync } from 'node:child_process'
import { existsSync, appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const dryRun = process.argv.includes('--dry-run')
const wantTags = process.argv.includes('--tag')
const inCI = !!process.env.GITHUB_ACTIONS

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

// pnpm knows which directories are workspace members; gitignored trees
// (dsh-model-picker) are never checked out in CI, so they cannot leak in.
const members = JSON.parse(run('pnpm', ['-r', 'list', '--depth', '-1', '--json']))
  .filter((p) => !p.private && p.name && p.version)

if (!members.length) {
  console.error('no publishable workspace packages found')
  process.exit(1)
}

// Preflight: every path named in "files" must exist. npm will happily publish a
// package that is missing half of them, and the break only shows up at runtime
// in someone else's harness.
const broken = []
for (const p of members) {
  const manifest = JSON.parse(await readFile(join(p.path, 'package.json'), 'utf8'))
  const missing = (manifest.files ?? [])
    .filter((f) => !f.includes('*') && !existsSync(join(p.path, f)))
  if (missing.length) broken.push(`${p.name}: files[] names missing paths — ${missing.join(', ')}`)
}
if (broken.length) {
  console.error('preflight failed:\n  ' + broken.join('\n  '))
  process.exit(1)
}

const publishedVersions = (name) => {
  try {
    return [].concat(JSON.parse(run('npm', ['view', name, 'versions', '--json'])))
  } catch (err) {
    // A package that has never been published 404s; anything else is a real error.
    if (/E404|404 Not Found/.test(String(err.stderr ?? err.message))) return []
    throw err
  }
}

// The packument read path lags badly for a freshly published package — it can
// 404 for many minutes while the write path already refuses the version as
// taken. dist-tags come off the primary and were correct while `npm view` was
// still 404ing, so they are the tiebreaker before we call a publish failed.
const versionIsUp = (name, version) => {
  if (publishedVersions(name).includes(version)) return true
  try {
    return run('npm', ['dist-tag', 'ls', name])
      .split('\n')
      .some((line) => line.split(':')[1]?.trim() === version)
  } catch {
    return false
  }
}

// A prerelease must not land on "latest" — `npm i @creait/dsh-hookkit` would
// then hand out an rc. npm refuses to guess, so name the channel after the
// prerelease identifier: 0.1.0-rc.9 -> rc.
const distTag = (version) => {
  const pre = version.split('-')[1]
  if (!pre) return 'latest'
  const id = pre.split('.')[0]
  return /^[a-z][a-z0-9-]*$/i.test(id) ? id : 'next'
}

const plan = members.map((p) => {
  const versions = publishedVersions(p.name)
  return {
    ...p,
    tag: distTag(p.version),
    skip: versionIsUp(p.name, p.version),
    first: versions.length === 0,
  }
})

for (const p of plan) {
  const state = p.skip ? 'up to date' : p.first ? 'FIRST PUBLISH' : 'publish'
  console.log(`${p.skip ? '·' : '→'} ${p.name}@${p.version}  [${p.tag}]  (${state})`)
}

const todo = plan.filter((p) => !p.skip)
if (!todo.length) {
  console.log('\nnothing to publish — every workspace version is already on the registry')
} else if (dryRun) {
  console.log(`\n--dry-run: would publish ${todo.length} package(s)`)
}

const published = []
for (const p of todo) {
  // npm, not pnpm: pnpm publish shells out to whatever npm is on PATH and its
  // OIDC/trusted-publishing path is unreliable through that hop.
  const args = ['publish', '--access', 'public', '--tag', p.tag]
  if (inCI) args.push('--provenance')
  if (dryRun) args.push('--dry-run')
  console.log(`\n$ npm ${args.join(' ')}  (in ${p.path})`)
  try {
    // stdio is inherited so the interactive 2FA browser hand-off reaches the
    // terminal; that means the failure reason has to be re-derived, not parsed.
    execFileSync('npm', args, { cwd: p.path, stdio: 'inherit' })
  } catch {
    if (!dryRun && versionIsUp(p.name, p.version)) {
      console.log(`\n${p.name}@${p.version} is already on the registry — skipping.`)
      continue
    }
    console.error(`\nnpm publish failed for ${p.name}@${p.version} — see the output above.`)
    if (published.length) console.error(`published this run: ${published.join(', ')}`)
    process.exit(1)
  }
  if (!dryRun) published.push(`${p.name}@${p.version}`)
}

if (wantTags && published.length) {
  for (const tag of published) run('git', ['tag', '-f', tag])
  console.log(`\ntagged: ${published.join(', ')}`)
}

if (inCI && process.env.GITHUB_STEP_SUMMARY) {
  const rows = plan
    .map((p) => `| \`${p.name}\` | ${p.version} | ${p.skip ? 'up to date' : dryRun ? 'would publish' : 'published'} |`)
    .join('\n')
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `## npm publish${dryRun ? ' (dry run)' : ''}\n\n| package | version | result |\n| --- | --- | --- |\n${rows}\n`,
  )
}
