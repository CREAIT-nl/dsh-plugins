/**
 * The research loop, as a workflow script.
 *
 * This is the part of the mode worth reading. It is a fixed, reviewed script —
 * not something a model writes per call — because the failure modes of a
 * research pipeline are structural, not creative: work silently dropped when a
 * budget runs out, the same question chased three rounds running, a report that
 * reads as complete because nobody counted what was never looked at. Those are
 * properties of the control flow, and a script that is authored fresh each time
 * re-earns them each time.
 *
 * The shape — plan, adaptive rounds, synthesis, adversarial review — is ported
 * from `dsh-deep-research` by omdsh-dev (MIT), which got the structure right.
 * Four things are fixed here:
 *
 *   1. BUDGET IS ACCOUNTED. The planner is told the ceiling up front, and every
 *      question that never runs is carried out of the loop by name — into the
 *      return value and into the report's own "what this does not cover"
 *      section. Upstream, work past the round cap simply vanished, and the
 *      report's coverage count vanished with it.
 *
 *   2. LEADS QUEUE INSTEAD OF EVAPORATING. High-priority gaps beyond one
 *      round's width were discarded upstream. Here they go on the back of the
 *      queue, and if the budget ends first they are named as deferred.
 *
 *   3. DEDUPLICATION IS GLOBAL. Upstream, the `seen` set was rebuilt every
 *      round, so a gap that three consecutive researchers reported got
 *      researched three times. One set, for the whole run.
 *
 *   4. SUPPLIED QUESTIONS STILL GET PLANNED. Upstream, passing your own
 *      questions skipped planning entirely — no scope, no dimensions, no
 *      coverage audit, and the synthesis stage had nothing to organise around.
 *      Here they are mandatory and verbatim, and the planner works on top of
 *      them instead of instead of them.
 *
 * Everything variable rides `args`, so the script itself is a constant: there
 * is no interpolation, and what runs is exactly what is reviewed here.
 *
 * @module @creait/dsh-research-mode/script
 */

/**
 * The workflow body. Plain JS, top-level await, ends in `return`. The engine
 * provides `agent`, `parallel`, `pipeline`, `phase`, `log` and `args`; no
 * filesystem, network or timers. Only `label`, `phase`, `schema`, `provider`
 * and `model` are accepted as `agent()` options — anything else is fatal.
 */
export const RESEARCH_SCRIPT = `
// ── inputs ──────────────────────────────────────────────────────────────────

const topic = args.topic;
const rounds = args.rounds;
const width = args.width;
const budget = rounds * width;
const supplied = args.questions;
const audience = args.audience;
const language = args.language;
const today = args.today;
const wantsReview = args.review;
const PLANNER_SCHEMA = args.schemas.planner;
const RESEARCHER_SCHEMA = args.schemas.researcher;

// Two questions that differ only in casing or punctuation are one question, and
// researching it twice spends a slot on nothing.
function key(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function clip(text, max) {
  const s = String(text);
  return s.length > max ? s.slice(0, max - 1) + '\\u2026' : s;
}

function joinLines(parts) {
  return parts.filter(function (part) { return part !== ''; }).join('\\n');
}

// ── planning ────────────────────────────────────────────────────────────────

function plannerPrompt() {
  const target = Math.max(3, Math.round(budget * 0.6));
  const parts = [];

  parts.push('You are the planning stage of a deep-research pipeline. You research nothing yourself; you decide what gets researched, and every stage after you is bounded by what you write here.');
  parts.push('');
  parts.push('RESEARCH REQUEST');
  parts.push(topic);
  if (audience !== '') {
    parts.push('');
    parts.push('The report is written for: ' + audience);
  }
  parts.push('');
  parts.push('TODAY IS ' + today + '. Treat recency as part of correctness where the topic moves.');
  parts.push('');
  parts.push('BUDGET \\u2014 a hard constraint, not a guideline.');
  parts.push('At most ' + budget + ' sub-questions will ever be researched (' + width + ' researchers per round, ' + rounds + ' rounds), and follow-up questions discovered mid-run compete for the same ' + budget + '. Plan around ' + target + ' questions so the loop has room to chase what the research turns up. Anything past the budget is reported to the reader as DEFERRED and never answered \\u2014 a longer list does not buy coverage, it buys a longer list of things the report has to admit it did not look at.');

  if (supplied.length > 0) {
    parts.push('');
    parts.push('QUESTIONS THE CALLER REQUIRES');
    parts.push('These were supplied by the caller and are mandatory. Reproduce each one VERBATIM in \\'questions\\', ordered by importance, ahead of any question of your own. Then do your own job on top of them: state the scope they imply, name the dimensions they cover, and record in \\'coverage_gaps\\' whatever a competent report on this topic needs that this list does not reach. Do not treat the list as complete just because it was given to you.');
    for (const question of supplied) parts.push('- ' + question);
  }

  parts.push('');
  parts.push('WHAT TO PRODUCE');
  parts.push('- scope: one paragraph. What question is this report actually answering, and what decision or understanding does it have to support? Name what is deliberately out of scope \\u2014 that is what stops the loop researching the wrong thing well.');
  parts.push('- dimensions: 3 to 6 distinct angles a complete answer has to cover. These are the axes the finished report is audited against, so choose the ones that matter for THIS topic rather than a generic template.');
  parts.push('- questions: concrete, independently researchable sub-questions. Each one must be answerable by a single researcher working alone with web search and page fetching, without seeing any other researcher\\'s work. Each carries:');
  parts.push('    dimension  \\u2014 one of the dimensions you named.');
  parts.push('    keywords   \\u2014 the search terms you would actually type, not a restatement of the question.');
  parts.push('    acceptance \\u2014 what an adequate answer contains: the specific fact, figure, comparison or class of source that would settle it. This is what tells a researcher when to stop.');
  parts.push('  Order them by importance. The budget is spent front-first, so question 1 is the one you would keep if you could keep only one.');
  parts.push('- coverage_gaps: what a complete answer needs that these questions cannot reach \\u2014 data that may not be public, claims that need primary sources you cannot obtain, areas where credible sources are known to disagree. Being honest here is worth more than being exhaustive above.');
  parts.push('');
  parts.push('Avoid questions that merely restate the topic, and questions whose only honest answer is "it depends" with nothing to check.');
  return joinLines(parts);
}

phase('Plan');
log('planning: budget is ' + budget + ' researched questions (' + width + ' wide, ' + rounds + ' rounds)');

const plan = await agent(plannerPrompt(), { label: 'plan', phase: 'Plan', schema: PLANNER_SCHEMA });
if (plan === null) throw new Error('the planner failed; there is nothing to research');

const planned = Array.isArray(plan.questions) ? plan.questions.filter(function (q) {
  return q !== null && typeof q === 'object' && typeof q.question === 'string' && q.question.trim() !== '';
}) : [];
if (planned.length === 0) throw new Error('the planner returned no researchable questions');

const dimensions = Array.isArray(plan.dimensions) ? plan.dimensions : [];
const scope = typeof plan.scope === 'string' ? plan.scope : topic;

// ── the research loop ───────────────────────────────────────────────────────

function researcherPrompt(item) {
  const parts = [];

  parts.push('You are one researcher in a deep-research pipeline, and you have exactly one sub-question. Other researchers are working the rest in parallel: do not cover the whole topic, and do not report on anything you were not asked.');
  parts.push('');
  parts.push('OVERALL SCOPE (context only \\u2014 not your assignment)');
  parts.push(scope);
  parts.push('');
  parts.push('YOUR SUB-QUESTION');
  parts.push(item.question);
  if (item.dimension !== undefined && item.dimension !== '') parts.push('Dimension: ' + item.dimension);
  if (item.keywords !== undefined && item.keywords !== '') parts.push('Suggested search terms: ' + item.keywords);
  if (item.acceptance !== undefined && item.acceptance !== '') parts.push('An adequate answer contains: ' + item.acceptance);
  if (item.followUp === true) {
    parts.push('');
    parts.push('This is a FOLLOW-UP. It surfaced in round ' + item.fromRound + ' as an unclosed gap in "' + item.from + '", so an earlier researcher already tried and did not get there. Assume the obvious search has been done.');
  }
  parts.push('');
  parts.push('TODAY IS ' + today + '.');
  parts.push('');
  parts.push('HOW TO WORK');
  parts.push('- Search, then READ. web_search returns snippets, and a snippet is a pointer rather than a source. Open what matters with web_fetch and take every claim from the page itself. Two or three genuinely read sources beat ten skimmed ones.');
  parts.push('- Prefer primary sources: documentation, specifications, standards, filings, papers, source code, the vendor\\'s own pages, the original announcement. A secondary source that cites a primary one is a route to that primary source, not a replacement for it.');
  parts.push('- Watch dates. On a fast-moving topic a two-year-old number is a different claim from a current one, and it must be reported with its date.');
  parts.push('- Corroborate anything surprising, contested, or load-bearing for the answer. One blog post is not a fact.');
  parts.push('- Stop when the acceptance condition is met, or when you have established that it cannot be met from available sources. The second is a real finding and must be reported as one.');
  parts.push('');
  parts.push('WHAT TO RETURN');
  parts.push('- confirmed: claims you actually verified by reading. Each needs a source: a URL you opened, or the exact title of the document. "Industry consensus" and "widely reported" are not sources. Set confidence yourself \\u2014 high for several independent sources or one authoritative primary one, medium for a single credible source, low for thinly sourced or visibly stale material.');
  parts.push('- uncertain: what you could not settle, each with the reason (sources disagree, paywalled, no public data, only stale figures). Do not promote these into confirmed to look complete. A named gap is worth more to the reader than a confident guess.');
  parts.push('- gaps: what else needs researching that you were not assigned. Mark high ONLY where the final report would be materially wrong or misleading without it \\u2014 high-priority gaps become real follow-up assignments and spend the run\\'s budget. Phrase each as a standalone researchable question, and do not restate your own sub-question.');
  parts.push('');
  parts.push('Never invent a URL, a figure, a date or a quotation. If you did not read it, it does not belong in confirmed.');
  return joinLines(parts);
}

// Everything queued, ever \\u2014 originals and follow-ups alike. Global for the
// whole run, so a gap three researchers independently report is researched
// once. Rebuilding this per round is fix (3) in the header.
const seen = new Set();

const queue = [];
for (const item of planned) {
  const k = key(item.question);
  if (seen.has(k)) continue;
  seen.add(k);
  queue.push(item);
}

const findings = [];
const failed = [];
const leadsSeen = [];
let followUps = 0;
let round = 0;

// Named here as well as on every researcher: the phase group should exist
// from the moment the rounds begin, not from whenever the first agent
// happens to report in.
phase('Research');

while (queue.length > 0 && round < rounds) {
  round += 1;
  const batch = queue.splice(0, width);
  log('round ' + round + '/' + rounds + ': researching ' + batch.length + ', ' + queue.length + ' queued');

  const results = await parallel(batch.map(function (item) {
    return function () {
      return agent(researcherPrompt(item), {
        label: 'r' + round + ': ' + clip(item.question, 60),
        phase: 'Research',
        schema: RESEARCHER_SCHEMA,
      });
    };
  }));

  const leads = [];
  for (let i = 0; i < batch.length; i += 1) {
    const item = batch[i];
    const found = results[i];
    if (found === null || found === undefined) {
      failed.push(item.question);
      continue;
    }
    findings.push({
      question: item.question,
      dimension: item.dimension === undefined ? '' : item.dimension,
      round: round,
      followUp: item.followUp === true,
      confirmed: Array.isArray(found.confirmed) ? found.confirmed : [],
      uncertain: Array.isArray(found.uncertain) ? found.uncertain : [],
    });

    if (!Array.isArray(found.gaps)) continue;
    for (const gap of found.gaps) {
      if (gap === null || typeof gap !== 'object') continue;
      const aspect = typeof gap.aspect === 'string' ? gap.aspect.trim() : '';
      if (aspect === '') continue;
      const k = key(aspect);
      if (leadsSeen.indexOf(k) === -1) leadsSeen.push(k);
      if (gap.priority !== 'high') continue;
      if (seen.has(k)) continue;
      seen.add(k);
      // Every high-priority lead is queued. Capping this at the round width is
      // fix (2): a discarded lead is a hole nobody ever hears about, while a
      // queued one either gets researched or gets named as deferred.
      leads.push({
        question: aspect,
        dimension: item.dimension,
        followUp: true,
        from: item.question,
        fromRound: round,
      });
    }
  }

  if (leads.length > 0) {
    followUps += leads.length;
    // Behind the originals, not ahead: the planned questions are the coverage
    // baseline, and follow-ups are depth bought only once breadth is paid for.
    for (const lead of leads) queue.push(lead);
    log('round ' + round + ' surfaced ' + leads.length + ' follow-up question(s)');
  }
}

// Fix (1): the budget runs out on the loop, not on the accounting. Whatever is
// still queued leaves by name and reaches the reader.
const deferred = queue.splice(0).map(function (item) { return item.question; });
if (deferred.length > 0) {
  log('budget exhausted with ' + deferred.length + ' question(s) unresearched; they are named in the report');
}
if (failed.length > 0) log(failed.length + ' researcher(s) failed; their questions are reported as unanswered');
if (findings.length === 0) throw new Error('every researcher failed; there is no evidence to write from');

// Leads nobody ever ran: the medium and low gaps, plus any high one that lost
// to the budget. Cheap to compute and it is exactly the "we did not look at
// this" list a reader needs.
const researched = new Set();
for (const finding of findings) researched.add(key(finding.question));
const openLeads = leadsSeen.filter(function (k) { return !researched.has(k); });

// ── synthesis ───────────────────────────────────────────────────────────────

const unanswered = deferred.concat(failed);

function coverageBlock() {
  const parts = [];
  parts.push('COVERAGE \\u2014 state these honestly; do not round them up.');
  parts.push('Researched ' + findings.length + ' question(s) over ' + round + ' round(s), of ' + planned.length + ' planned and ' + followUps + ' follow-up(s) surfaced.');
  if (unanswered.length > 0) {
    parts.push('NEVER ANSWERED (' + unanswered.length + ') \\u2014 the report must not imply otherwise:');
    for (const question of unanswered) parts.push('- ' + question);
  } else {
    parts.push('Every planned and follow-up question was researched.');
  }
  if (openLeads.length > 0) {
    parts.push('Leads raised during research and not pursued: ' + openLeads.length + '.');
  }
  return joinLines(parts);
}

function synthesisPrompt() {
  const parts = [];

  parts.push('You are the synthesis stage of a deep-research pipeline. The research is finished and you write the report. Work from the evidence below: it is what was actually established, and anything absent from it is not established. You may use web_search or web_fetch to settle one specific contradiction or fill a small named hole, but do not restart the research.');
  parts.push('');
  parts.push('RESEARCH REQUEST');
  parts.push(topic);
  parts.push('');
  parts.push('SCOPE');
  parts.push(scope);
  if (dimensions.length > 0) {
    parts.push('');
    parts.push('DIMENSIONS THE ANSWER HAS TO COVER');
    for (const dimension of dimensions) parts.push('- ' + dimension);
  }
  if (audience !== '') {
    parts.push('');
    parts.push('AUDIENCE: ' + audience);
  }
  parts.push('');
  parts.push(coverageBlock());
  parts.push('');
  parts.push('EVIDENCE (JSON: one entry per researched sub-question)');
  parts.push(JSON.stringify(findings, null, 1));
  parts.push('');
  parts.push('WRITE THE REPORT');
  parts.push('- Markdown, written in ' + language + '. Length is whatever the evidence supports and no more.');
  parts.push('- Open with a direct answer to the research request, in a short paragraph, before any background. Where the honest answer is "it depends" or "the evidence does not settle this", that is the opening sentence rather than the buried conclusion.');
  parts.push('- Organise the body around what the reader needs to know. Do NOT write one section per sub-question and do not follow the order the research happened in \\u2014 that is the pipeline\\'s shape, not the topic\\'s.');
  parts.push('- Cite inline as [1], [2] against a numbered Sources list at the end. Every number resolves to a URL or document name that appears in the evidence above. Do not cite anything that is not there, and do not invent citation numbers.');
  parts.push('- Carry uncertainty through instead of flattening it. A claim the evidence marks low confidence is reported as thin; where sources conflict, give both readings and say who holds which. Never average disagreeing sources into a consensus that no source states.');
  parts.push('- Attribute contested claims to whoever makes them rather than asserting them in your own voice.');
  parts.push('- Close with a section titled "What this report does not cover". List every never-answered question above verbatim, then the substantive uncertainties from the evidence. This section is mandatory even when the list is short: a research report whose limits are invisible reads as more complete than it is.');
  parts.push('');
  parts.push('No filler, no "in conclusion", no restating the request back at the reader. Return the report and nothing else.');
  return joinLines(parts);
}

phase('Synthesize');
log('synthesising from ' + findings.length + ' researched question(s)');

let report = await agent(synthesisPrompt(), { label: 'synthesise', phase: 'Synthesize' });
if (report === null || String(report).trim() === '') throw new Error('synthesis failed; no report was produced');

// ── adversarial review ──────────────────────────────────────────────────────

let critique = '';

if (wantsReview === true) {
  phase('Review');

  const reviewParts = [];
  reviewParts.push('You are reviewing a research report against the evidence it was built from, before it reaches its reader. Be adversarial: find what is wrong with it. Do not praise it, and do not summarise it.');
  reviewParts.push('');
  reviewParts.push('RESEARCH REQUEST');
  reviewParts.push(topic);
  reviewParts.push('');
  reviewParts.push(coverageBlock());
  if (dimensions.length > 0) {
    reviewParts.push('');
    reviewParts.push('DIMENSIONS THE ANSWER HAD TO COVER');
    for (const dimension of dimensions) reviewParts.push('- ' + dimension);
  }
  reviewParts.push('');
  reviewParts.push('EVIDENCE (JSON)');
  reviewParts.push(JSON.stringify(findings, null, 1));
  reviewParts.push('');
  reviewParts.push('REPORT');
  reviewParts.push(report);
  reviewParts.push('');
  reviewParts.push('CHECK IN THIS ORDER');
  reviewParts.push('1. FABRICATION. Every factual claim and every citation must trace to the evidence. Name any claim that does not, and any citation number resolving to a source the evidence never contains. This check matters more than the rest combined.');
  reviewParts.push('2. OVERCLAIM. Anything the evidence marks uncertain or low-confidence that the report states flatly, and anything hedged in the evidence but confident in the report.');
  reviewParts.push('3. CONTRADICTION. Places where the evidence disagrees with itself and the report quietly picked a side.');
  reviewParts.push('4. COVERAGE HONESTY. Does the closing section name every never-answered question? Does anything in the report imply coverage the run did not have?');
  reviewParts.push('5. DIMENSIONS. Which named dimensions are thin or missing?');
  reviewParts.push('6. ANSWER. Does the report answer the request in its opening paragraph, or does it circle?');
  reviewParts.push('');
  reviewParts.push('Return a numbered list of concrete, fixable defects, each quoting the offending text. Where a check passes, say so in one line \\u2014 do not manufacture a defect to look thorough. End with one line naming the single most damaging problem.');

  critique = await agent(joinLines(reviewParts), { label: 'review', phase: 'Review' });

  if (critique !== null && String(critique).trim() !== '') {
    const reviseParts = [];
    reviseParts.push('Revise the research report below against the review that follows it.');
    reviseParts.push('');
    reviseParts.push('Fix what the review is right about. Where it is wrong, leave the text as it stands \\u2014 a review is evidence about the report, not an instruction. Never add a claim to satisfy a criticism: where the defect is an unsupported claim, the fix is to cut it or attribute it honestly, never to source it after the fact. Keep every well-supported claim, keep the citation numbering consistent with the Sources list, and keep the "What this report does not cover" section.');
    reviseParts.push('');
    reviseParts.push('REPORT');
    reviseParts.push(report);
    reviseParts.push('');
    reviseParts.push('REVIEW');
    reviseParts.push(critique);
    reviseParts.push('');
    reviseParts.push('Return the complete revised report and nothing else: no preamble, no changelog, no note about what you changed.');

    const revised = await agent(joinLines(reviseParts), { label: 'revise', phase: 'Review' });
    if (revised !== null && String(revised).trim() !== '') report = revised;
  } else {
    critique = '';
    log('the reviewer failed; returning the unreviewed report');
  }
}

// ── result ──────────────────────────────────────────────────────────────────

const sources = [];
const sourcesSeen = new Set();
for (const finding of findings) {
  for (const claim of finding.confirmed) {
    if (claim === null || typeof claim !== 'object') continue;
    const source = typeof claim.source === 'string' ? claim.source.trim() : '';
    if (source === '' || sourcesSeen.has(source)) continue;
    sourcesSeen.add(source);
    sources.push(source);
  }
}

let claims = 0;
let lowConfidence = 0;
let uncertainties = 0;
for (const finding of findings) {
  claims += finding.confirmed.length;
  uncertainties += finding.uncertain.length;
  for (const claim of finding.confirmed) {
    if (claim !== null && typeof claim === 'object' && claim.confidence === 'low') lowConfidence += 1;
  }
}

return {
  topic: topic,
  scope: scope,
  dimensions: dimensions,
  report: String(report),
  critique: String(critique),
  sources: sources,
  coverage: {
    planned: planned.length,
    followUps: followUps,
    researched: findings.length,
    deferred: deferred,
    failed: failed,
    openLeads: openLeads.length,
    rounds: round,
    roundBudget: rounds,
    width: width,
    claims: claims,
    lowConfidence: lowConfidence,
    uncertainties: uncertainties,
    reviewed: wantsReview === true && critique !== '',
  },
};
`;
