#!/usr/bin/env node
// Set up a bulk editing batch before the footage arrives.
//
// A batch is one shared main body plus several hooks. Each hook and the body get
// their own project in video-projects/, with the script, the planned beats, and
// the source lines already in place. Each finished ad is hook + body, joined
// with scripts/stitch-variant.mjs.
//
// Usage (from the kit root):
//   node scripts/new-batch.mjs <batch.json>            create every project that is missing
//   node scripts/new-batch.mjs <batch.json> --dry-run  show what would be created
//
// batch.json:
// {
//   "name": "acme-q4", "client": "acme",
//   "format": { "width": 1080, "height": 1920, "fps": 30 },
//   "template": "video-projects/acme-old-ad",               optional
//   "copyFromTemplate": ["assets/sfx", "assets/music.wav"],  optional, relative to the template
//   "body":  { "slug": "acme-q4-body", "title": "Main body", "lines": ["..."], "beats": [...] },
//   "hooks": [{ "id": "h01", "slug": "acme-q4-h01", "title": "...", "lines": ["..."], "beats": [...] }]
// }
// A beat is { "id": "b1", "anchor": "first words of the beat as spoken", ...plan fields }.

import { existsSync, readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Check a batch manifest and return a list of problems (empty when valid). */
export function checkBatch(batch) {
  const problems = [];
  if (!batch || typeof batch !== 'object') return ['Batch file is not a JSON object.'];
  if (!batch.name) problems.push('Missing "name".');
  if (!batch.body) problems.push('Missing "body".');
  if (!Array.isArray(batch.hooks) || batch.hooks.length === 0) problems.push('Add at least one entry to "hooks".');
  const seen = new Set();
  for (const part of [batch.body, ...(batch.hooks ?? [])].filter(Boolean)) {
    const label = part.id ?? part.slug ?? '(unnamed)';
    if (!SLUG.test(part.slug ?? '')) problems.push(`${label}: "slug" must be lowercase kebab-case.`);
    if (seen.has(part.slug)) problems.push(`${label}: duplicate slug ${part.slug}.`);
    seen.add(part.slug);
    if (!Array.isArray(part.lines) || part.lines.length === 0) problems.push(`${label}: add the spoken "lines".`);
    const beatIds = new Set();
    for (const beat of part.beats ?? []) {
      if (!beat.id || !beat.anchor) problems.push(`${label}: every beat needs "id" and "anchor".`);
      if (beatIds.has(beat.id)) problems.push(`${label}: duplicate beat id ${beat.id}.`);
      beatIds.add(beat.id);
      const spoken = normalizeWords(part.lines.join(' ')).join(' ');
      if (beat.anchor && !spoken.includes(normalizeWords(beat.anchor).join(' '))) {
        problems.push(`${label} ${beat.id}: anchor "${beat.anchor}" is not in the script lines.`);
      }
    }
  }
  return problems;
}

/** Lowercase words without punctuation, so script and transcript text compare fairly. */
export function normalizeWords(text) {
  return String(text)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[^a-z0-9'%.$-]+/g, ' ')
    .replace(/(^|\s)[$.'-]+|[.'-]+(?=\s|$)/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The SCRIPT.md written into each project. */
export function scriptMarkdown(part, batch, role) {
  const out = [`# ${part.title ?? part.slug}`, ''];
  out.push(`Batch: ${batch.name}${batch.client ? ` · Client: ${batch.client}` : ''} · Part: ${role}`);
  if (part.group) out.push(`Audience group: ${part.group}`);
  if (part.hookType) out.push(`Hook type: ${part.hookType}`);
  if (part.headline) out.push(`On-screen hook headline: ${part.headline}`);
  out.push('', '## Spoken script', '', ...part.lines.map((l) => `> ${l}`), '');
  if (part.beats?.length) {
    out.push('## Beat plan', '', '| Beat | Starts on | Layout | Visual | On screen | Sound |', '| --- | --- | --- | --- | --- | --- |');
    for (const b of part.beats) {
      const cell = (v) => String(v ?? '').replace(/\|/g, '/');
      out.push(`| ${b.id} | "${cell(b.anchor)}" | ${cell(b.layout)} | ${cell(b.visual)} | ${cell(b.onScreen)} | ${cell(b.sfx)} |`);
    }
    out.push('');
  }
  if (part.notes?.length) out.push('## Edit notes', '', ...part.notes.map((n) => `- ${n}`), '');
  if (part.sources?.length) out.push('## Sources for the editor (not read aloud)', '', ...part.sources.map((s) => `- ${s}`), '');
  if (part.flags?.length) out.push('## Open questions before this part is final', '', ...part.flags.map((f) => `- [ ] ${f}`), '');
  out.push('## When the footage lands', '',
    '1. Put the take at `assets/raw.mp4`, cut silences and mistakes, and save `assets/transcript.json` for the edited video.',
    `2. Run \`node scripts/plan-from-script.mjs video-projects/${part.slug}\` to time the beats and check the take against this script.`,
    '3. Build, verify, and open the review board before stitching.', '');
  return out.join('\n');
}

/** The planned ads: one per hook, each hook followed by the body. */
export function plannedVariants(batch) {
  return batch.hooks.map((h) => ({
    id: h.id ?? h.slug,
    title: h.title ?? h.slug,
    hookType: h.hookType ?? '',
    hook: `video-projects/${h.slug}`,
    body: `video-projects/${batch.body.slug}`,
    file: h.output ?? `${batch.name}-${h.id ?? h.slug}.mp4`,
  }));
}

function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const dry = args.includes('--dry-run');
  if (!file) {
    console.log('Usage: node scripts/new-batch.mjs <batch.json> [--dry-run]');
    process.exit(1);
  }
  const batchPath = resolve(file);
  const batch = JSON.parse(readFileSync(batchPath, 'utf8').replace(/^﻿/, ''));
  const problems = checkBatch(batch);
  if (problems.length) {
    console.error(`Batch file has ${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  const fmt = { width: 1080, height: 1920, fps: 30, ...(batch.format ?? {}) };
  const template = batch.template ? resolve(root, batch.template) : null;
  if (template && !existsSync(template)) throw new Error(`Template project not found: ${batch.template}`);

  const parts = [['body', batch.body], ...batch.hooks.map((h) => ['hook', h])];
  for (const [role, part] of parts) {
    const dest = join(root, 'video-projects', part.slug);
    if (existsSync(dest)) {
      console.log(`skip    video-projects/${part.slug} (already exists)`);
      continue;
    }
    console.log(`${dry ? 'would create' : 'create '} video-projects/${part.slug}  (${role}: ${part.title ?? ''})`);
    if (dry) continue;
    const made = spawnSync(process.execPath, [join(root, 'scripts/new-video.mjs'), part.slug], { encoding: 'utf8', cwd: root });
    if (made.status !== 0) throw new Error(made.stderr || made.stdout);
    const metaPath = join(dest, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
    Object.assign(meta, { width: fmt.width, height: fmt.height, fps: fmt.fps });
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n');
    for (const rel of batch.copyFromTemplate ?? []) {
      const from = join(template ?? root, rel);
      if (!existsSync(from)) { console.warn(`  missing in template: ${rel}`); continue; }
      mkdirSync(dirname(join(dest, rel)), { recursive: true });
      cpSync(from, join(dest, rel), { recursive: true });
    }
    writeFileSync(join(dest, 'script.json'), JSON.stringify({ batch: batch.name, client: batch.client, role, ...part }, null, 2) + '\n');
    writeFileSync(join(dest, 'SCRIPT.md'), scriptMarkdown(part, batch, role));
  }
  const variantsPath = join(dirname(batchPath), 'VARIANTS.json');
  if (!dry) {
    writeFileSync(variantsPath, JSON.stringify(plannedVariants(batch), null, 2) + '\n');
    console.log(`\nPlanned ${batch.hooks.length} ads (hook + body) in ${basename(dirname(batchPath))}/VARIANTS.json`);
    console.log('Edit the body once, each hook on its own, then join them with scripts/stitch-variant.mjs.');
    console.log(`Note: the starter's index.html is ${fmt.width}x${fmt.height} only after you set it; build each project for that size.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
