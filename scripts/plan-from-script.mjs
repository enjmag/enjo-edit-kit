#!/usr/bin/env node
// Time a project's scripted beats against the edited transcript, and check the
// take against the script.
//
// Reads <project>/script.json (written by new-batch.mjs) and the edited video's
// word transcript (assets/transcript.json, or --transcript <file>). Writes:
//   assets/plan.json   beat scenes on the edited timeline (only when it does not
//                      exist yet, or with --force), so the review board shows
//                      one card per scripted beat
//   SCRIPT-CHECK.md    words the speaker skipped, added, or changed, and beats
//                      whose first words were not found
//
// Usage: node scripts/plan-from-script.mjs video-projects/<slug> [--transcript f] [--duration s] [--force]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWords } from './new-batch.mjs';

/** Spoken words from a transcript: [{ text, norm, start, end }]. */
export function transcriptWords(transcript) {
  const out = [];
  for (const w of transcript?.words ?? []) {
    if (w.type && w.type !== 'word') continue;
    const text = String(w.text ?? w.word ?? '').trim();
    if (!text) continue;
    for (const norm of normalizeWords(text)) out.push({ text, norm, start: Number(w.start), end: Number(w.end) });
  }
  return out;
}

/** Index of the first occurrence of needle in hay at or after `from`, or -1. */
function findSeq(hay, needle, from) {
  outer: for (let i = Math.max(0, from); i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Find each beat's start in the spoken words, in order. A beat whose full anchor
 * is missing is matched on its first three words, then its first two. The first
 * beat falls back to the first spoken word.
 */
export function locateBeats(beats, words) {
  const norms = words.map((w) => w.norm);
  let cursor = 0;
  return beats.map((beat, k) => {
    const anchor = normalizeWords(beat.anchor);
    for (const len of [anchor.length, 3, 2]) {
      if (len > anchor.length || len < 1) continue;
      const at = findSeq(norms, anchor.slice(0, len), cursor);
      if (at > -1) {
        cursor = at + len;
        return { ...beat, wordIndex: at, start: words[at].start, matched: len === anchor.length ? 'exact' : `first ${len} words` };
      }
    }
    // The first beat always opens the video, even when its opening words were changed.
    if (k === 0) return { ...beat, wordIndex: 0, start: words[0].start, matched: 'opening words differ; placed at the start' };
    return { ...beat, wordIndex: -1, start: null, matched: 'not found' };
  });
}

/** Word-level difference between script and speech (longest common subsequence). */
export function diffWords(scriptWords, spokenWords) {
  const n = scriptWords.length, m = spokenWords.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    dp[i][j] = scriptWords[i] === spokenWords[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && scriptWords[i] === spokenWords[j]) { ops.push({ op: 'same', word: scriptWords[i], j }); i++; j++; }
    else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { ops.push({ op: 'added', word: spokenWords[j], j }); j++; }
    else { ops.push({ op: 'missing', word: scriptWords[i], j }); i++; }
  }
  // Group neighbouring changes so "2900 -> two thousand nine hundred" reads as one change.
  const changes = [];
  ops.forEach((o, k) => {
    if (o.op === 'same') return;
    const last = changes.at(-1);
    if (last && last.endOp === k - 1) {
      (o.op === 'missing' ? last.missing : last.added).push(o.word);
      last.endOp = k;
    } else {
      changes.push({ at: o.j, missing: o.op === 'missing' ? [o.word] : [], added: o.op === 'added' ? [o.word] : [], endOp: k });
    }
  });
  const same = ops.filter((o) => o.op === 'same').length;
  return { coverage: n ? same / n : 1, changes: changes.map(({ endOp, ...c }) => c) };
}

/** Scenes for assets/plan.json from located beats. */
export function scenesFromBeats(located, duration) {
  const found = located.filter((b) => b.start !== null);
  return found.map((b, k) => {
    const start = k === 0 ? 0 : Math.max(0, b.start - 0.05);
    const next = found[k + 1];
    const end = next ? Math.max(start + 0.1, next.start - 0.05) : duration;
    const scene = { id: b.id, start: round(start), end: round(end), layout: b.layout ?? 'face', kind: b.kind ?? 'beat', anchor: b.anchor, anchorTime: round(b.start) };
    if (b.visual) scene.visual = b.visual;
    if (b.onScreen) scene.onScreen = b.onScreen;
    return scene;
  });
}

const round = (n) => Math.round(n * 1000) / 1000;

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : undefined; };
  const dir = args.find((a, i) => !a.startsWith('--') && !['--transcript', '--duration'].includes(args[i - 1]));
  if (!dir) { console.log('Usage: node scripts/plan-from-script.mjs video-projects/<slug> [--transcript f] [--duration s] [--force]'); process.exit(1); }
  const project = resolve(dir);
  const script = JSON.parse(readFileSync(join(project, 'script.json'), 'utf8').replace(/^﻿/, ''));
  const tPath = resolve(project, opt('--transcript') ?? 'assets/transcript.json');
  if (!existsSync(tPath)) throw new Error(`No transcript at ${relative(process.cwd(), tPath)}. Transcribe the edited video first.`);
  const words = transcriptWords(JSON.parse(readFileSync(tPath, 'utf8').replace(/^﻿/, '')));
  if (!words.length) throw new Error('The transcript has no words.');
  const duration = Number(opt('--duration') ?? (words.at(-1).end + 0.4));
  const meta = existsSync(join(project, 'meta.json')) ? JSON.parse(readFileSync(join(project, 'meta.json'), 'utf8').replace(/^﻿/, '')) : {};

  const located = locateBeats(script.beats ?? [], words);
  const diff = diffWords(normalizeWords(script.lines.join(' ')), words.map((w) => w.norm));

  const planPath = join(project, 'assets', 'plan.json');
  let wrotePlan = false;
  if (!existsSync(planPath) || args.includes('--force')) {
    mkdirSync(join(project, 'assets'), { recursive: true });
    writeFileSync(planPath, JSON.stringify({ duration: round(duration), fps: meta.fps ?? 30, scenes: scenesFromBeats(located, duration), events: [], captions: [] }, null, 2) + '\n');
    wrotePlan = true;
  }

  const lines = [`# Script check: ${script.title ?? script.slug}`, '', `Transcript: ${relative(project, tPath)}`, '',
    `Script words spoken as written: ${(diff.coverage * 100).toFixed(1)}%`, '', '## Beats', '',
    '| Beat | Starts on | Found at | Match |', '| --- | --- | --- | --- |',
    ...located.map((b) => `| ${b.id} | "${b.anchor}" | ${b.start === null ? '-' : b.start.toFixed(2) + ' s'} | ${b.matched} |`), ''];
  lines.push('## Differences from the script', '');
  if (!diff.changes.length) lines.push('None. Every scripted word was spoken in order.');
  for (const c of diff.changes) {
    const t = words[Math.min(c.at, words.length - 1)]?.start;
    const said = c.added.length ? `said "${c.added.join(' ')}"` : 'said nothing';
    const wrote = c.missing.length ? `script has "${c.missing.join(' ')}"` : 'not in the script';
    lines.push(`- ${t === undefined ? '' : t.toFixed(2) + ' s: '}${said}; ${wrote}`);
  }
  lines.push('', 'Numbers spoken as words ("two thousand nine hundred") show up here as differences. Check that every number, date, and name was said correctly and that no claim was added; fix captions to the script spelling only when the speech matches it.', '');
  writeFileSync(join(project, 'SCRIPT-CHECK.md'), lines.join('\n'));

  const missing = located.filter((b) => b.start === null).map((b) => b.id);
  console.log(`${script.slug ?? dir}: ${(diff.coverage * 100).toFixed(1)}% of script words spoken as written, ${diff.changes.length} difference(s).`);
  console.log(`Beats found: ${located.length - missing.length}/${located.length}${missing.length ? ` (not found: ${missing.join(', ')})` : ''}.`);
  console.log(wrotePlan ? `Wrote ${relative(process.cwd(), planPath)}.` : 'Kept the existing assets/plan.json (use --force to replace its scenes).');
  console.log(`Wrote ${relative(process.cwd(), join(project, 'SCRIPT-CHECK.md'))}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
