#!/usr/bin/env node
// Build one-line caption chunks from a word-level transcript.
// Usage: node scripts/build-captions.mjs <transcript.json> --out caps.js [--max 24] [--end 82.3]
//        [--replace "eighth of=>8th of" --replace "twenty sixteen=>2016"]
// Rules (from client review notes):
//  - One line per chunk. Split long sentences at phrase boundaries instead of wrapping.
//  - Never leave a single word alone: a one-word chunk takes the previous chunk's last word
//    ("you before the day gets" + "busy." -> "you before the day" + "gets busy."), or merges
//    with a neighbour when that still fits on one line.
//  - Chunks follow word timing; each ends just before the next starts (max +0.3 s hang).
import { readFileSync, writeFileSync } from 'node:fs';

const a = process.argv.slice(2);
const src = a[0];
const opt = (k, d) => { const i = a.indexOf(k); return i > -1 ? a[i + 1] : d; };
const MAX = Number(opt('--max', '24'));
const out = opt('--out', 'caps.js');
const reps = []; a.forEach((x, i) => { if (x === '--replace') { const [f, t] = a[i + 1].split('=>'); reps.push([f, t]); } });
const j = JSON.parse(readFileSync(src, 'utf8').replace(/^﻿/, ''));
const words = (j.words || []).filter(w => w.type !== 'spacing' && String(w.text).trim());
const END = Number(opt('--end', String(words.at(-1).end + 0.3)));
const text = ws => ws.map(w => w.text).join(' ');
const sentenceEnd = w => /[.?!]$/.test(w.text);

// Word pairs that must never be split across captions (--keep "en bloc", repeatable).
const keep = ['en bloc', 'new launches'];
a.forEach((x, i) => { if (x === '--keep') keep.push(a[i + 1].toLowerCase()); });
const bare = w => w.text.toLowerCase().replace(/[^a-z0-9']/g, '');
const joined = (w1, w2) => keep.includes(`${bare(w1)} ${bare(w2)}`);

// 1. Greedy chunks.
let chunks = []; let cur = [];
for (const w of words) {
  if (cur.length) {
    const t = text(cur), last = cur.at(-1), gap = w.start - last.end;
    const commaBreak = /,$/.test(last.text) && t.length >= 9;
    if (t.length + 1 + w.text.length > MAX || sentenceEnd(last) || commaBreak || gap > 0.35) {
      if (joined(last, w) && cur.length > 1) { const moved = cur.pop(); chunks.push(cur); cur = [moved]; }
      else if (!joined(last, w) || gap > 0.35) { chunks.push(cur); cur = []; }
    }
  }
  cur.push(w);
}
if (cur.length) chunks.push(cur);

// 2. No lone words.
let changed = true;
while (changed) {
  changed = false;
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]; if (c.length !== 1) continue;
    const p = chunks[i - 1], n = chunks[i + 1];
    if (p && p.length >= 3 && !sentenceEnd(p.at(-1)) && text([p.at(-1), ...c]).length <= MAX) { c.unshift(p.pop()); changed = true; break; }
    if (n && !sentenceEnd(c[0]) && text([...c, ...n]).length <= MAX && n[0].start - c[0].end < 0.4) { chunks[i + 1] = [...c, ...n]; chunks.splice(i, 1); changed = true; break; }
    if (p && text([...p, ...c]).length <= MAX + 4 && c[0].start - p.at(-1).end < 0.4) { chunks[i - 1] = [...p, ...c]; chunks.splice(i, 1); changed = true; break; }
  }
}

// 3. Times and text.
const rows = chunks.map((c, i) => {
  const s = c[0].start, next = chunks[i + 1] ? chunks[i + 1][0].start : END;
  const e = Math.min(next - 0.02, c.at(-1).end + 0.3);
  let t = text(c); for (const [f, r] of reps) t = t.split(f).join(r);
  return [s, e, t];
});
writeFileSync(out, rows.map(([s, e, t]) => `[${s.toFixed(2)},${e.toFixed(2)},${JSON.stringify(t)}]`).join(',\n') + '\n');
const lone = rows.filter(r => !r[2].includes(' ')).map(r => r[2]);
console.log(`${rows.length} captions, longest ${Math.max(...rows.map(r => r[2].length))} chars, one-word captions: ${lone.length ? lone.join(' | ') : 'none'}`);
