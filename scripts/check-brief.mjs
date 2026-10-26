#!/usr/bin/env node
// Checks that a client brief answers every required section before an edit starts.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_SECTIONS = [
  'Business and offer',
  'Audience',
  'Problem and desire',
  'Main objection',
  'Proof available',
  'Call to action',
  'Platform and format',
  'Success metric',
  'Tone and must-avoids',
  'Hook ideas and angles',
  'Deliverables and deadline',
];

// Template guidance paragraphs are kept; only TODO markers and empty sections fail.
export function checkBrief(text) {
  const errors = [];
  const sections = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { current = heading[1]; sections.set(current, []); continue; }
    if (current) sections.get(current).push(line);
  }
  for (const name of REQUIRED_SECTIONS) {
    if (!sections.has(name)) { errors.push(`Missing section: ${name}`); continue; }
    const body = sections.get(name).join('\n').trim();
    if (!body) errors.push(`Empty section: ${name}`);
    else if (/\bTODO\b/.test(body)) errors.push(`Unanswered section: ${name}`);
  }
  if (/CLIENT NAME/.test(text)) errors.push('Replace CLIENT NAME in the title');
  return { ok: errors.length === 0, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = process.argv[2];
  if (!target) { console.log('Usage: npm run check:brief -- clients/<slug>'); process.exit(1); }
  const file = existsSync(target) && statSync(target).isDirectory() ? join(target, 'BRIEF.md') : target;
  if (!existsSync(file)) { console.error(`No brief found at ${file}`); process.exit(1); }
  const { ok, errors } = checkBrief(readFileSync(file, 'utf8'));
  if (ok) console.log(`Brief complete: ${file}`);
  else { console.error(`Brief incomplete: ${file}`); for (const e of errors) console.error(`- ${e}`); }
  process.exitCode = ok ? 0 : 1;
}
