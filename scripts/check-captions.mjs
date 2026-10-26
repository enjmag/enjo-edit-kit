#!/usr/bin/env node
// Fail if any caption in a HyperFrames project wraps, overflows, or leaves one word alone on a line.
// Usage: node scripts/check-captions.mjs <project-dir> [--selector "#captions .cap"]
// Loads index.html headlessly, measures every caption element at its final size, and
// counts its rendered lines with Range.getClientRects (works for nowrap and wrapped text).
import { chromium } from 'playwright';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const a = process.argv.slice(2);
const dir = resolve(a[0] || '.');
const i = a.indexOf('--selector'); const sel = i > -1 ? a[i + 1] : '#captions .cap';
// Prefer the installed Chrome (no Playwright browser download needed).
let browser;
try { browser = await chromium.launch({ channel: 'chrome', args: ['--disable-gpu'] }); }
catch { browser = await chromium.launch({ args: ['--disable-gpu'] }); }
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.goto(pathToFileURL(join(dir, 'index.html')).href);
// Use the same Google font HyperFrames embeds at render time, then wait for it.
await page.addStyleTag({ url: 'https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Oswald:wght@700&display=block' });
await page.evaluate(async () => { await document.fonts.load('600 58px Poppins'); await document.fonts.ready; window.__fitCaptions && window.__fitCaptions(); });
await page.waitForTimeout(300);
const res = await page.evaluate((sel) => {
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    const prev = [el.style.visibility, el.style.opacity];
    el.style.visibility = 'visible'; el.style.opacity = '1';
    const box = el.getBoundingClientRect();
    // Group the words of the caption by their rendered line (top coordinate).
    const lines = new Map();
    const node = el.firstChild;
    if (node && node.nodeType === 3) {
      const txt = node.textContent; let pos = 0;
      for (const w of txt.split(' ')) {
        const r = document.createRange(); r.setStart(node, pos); r.setEnd(node, pos + w.length);
        const rect = r.getClientRects()[0]; pos += w.length + 1;
        if (!rect) continue; const k = Math.round(rect.top);
        lines.set(k, [...(lines.get(k) || []), w]);
      }
    }
    const overflow = el.scrollWidth > el.clientWidth + 1;
    out.push({ text: el.textContent, lines: [...lines.values()].map(l => l.join(' ')), overflow, fontSize: getComputedStyle(el).fontSize, width: Math.round(box.width) });
    el.style.visibility = prev[0]; el.style.opacity = prev[1];
  }
  return out;
}, sel);
await browser.close();
const bad = res.filter(r => r.overflow || r.lines.length > 2 || (r.lines.length === 2 && r.lines.some(l => !l.includes(' '))));
const twoLine = res.filter(r => r.lines.length === 2);
console.log(`${res.length} captions checked: ${twoLine.length} on two lines, ${bad.length} failing`);
for (const b of bad) console.log(`  FAIL: "${b.text}" -> ${JSON.stringify(b.lines)}${b.overflow ? ' (overflows)' : ''}`);
const shrunk = res.filter(r => parseFloat(r.fontSize) < 58);
if (shrunk.length) console.log(`  shrunk to fit one line: ${shrunk.map(r => `"${r.text}" ${r.fontSize}`).join(', ')}`);
process.exitCode = bad.length ? 1 : 0;
