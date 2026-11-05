#!/usr/bin/env node
// Review board. Two views of a rendered draft:
// - Timeline (default for one video): a Frame.io-style player where you pause
//   anywhere and leave a comment pinned to that timestamp, with an optional
//   drawing on the frame.
// - Beats (default for a batch, or --beats): one card per beat with Approve /
//   Change, a note box, Draw-on-frame, reference upload, and "New idea".
// Notes save into <project>/review/REVIEW.json so Claude fixes only what you flagged.
//
// Usage:
//   npm run review -- video-projects/<slug>                      timeline comments on one video
//   npm run review -- video-projects/<slug> --beats              beat cards instead
//   npm run review -- video-projects/<a> video-projects/<b>      a batch (beat cards; add --timeline for comments)
//   npm run review -- --all                                       every project with a video
//   npm run review -- video-projects/<slug> --notes               print the to-do list
//   npm run review -- video-projects/<slug> --mark-revised b03,b05   (or comment ids: c01,c04)
// Options: --video <file.mp4>  --every <seconds>  --port <n>  --no-open

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, createReadStream } from 'node:fs';
import { resolve, join, relative, basename, extname, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const STATUSES = ['waiting', 'approved', 'change'];
const round2 = (n) => Math.round(n * 100) / 100;
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const attr = (raw, name) => raw.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] ?? null;

// ---------- beats ----------

/** Visible text of an HTML fragment (scripts, styles and tags removed). */
export function visibleText(html) {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Beats from assets/plan.json scenes (short-form projects). */
export function beatsFromPlan(plan) {
  return (plan?.scenes ?? []).map((s) => ({
    key: String(s.id),
    start: Number(s.start),
    end: Number(s.end),
    label: [s.kind, s.layout].filter(Boolean).join(' · '),
    intent: s.anchor ? `Anchored to "${s.anchor}"` : '',
    onScreen: '',
  }));
}

/** Beats from the root index.html: timed sub-compositions with data-composition-src. */
export function beatsFromIndex(html, readComposition = () => '') {
  const out = [];
  const re = /<div\b([^>]*\bdata-composition-src\s*=[^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const a = m[1];
    // The HTML comment directly above a beat usually explains its intent.
    const before = html.slice(Math.max(0, m.index - 2000), m.index);
    const note = before.match(/<!--((?:(?!-->)[\s\S])*)-->\s*$/);
    const start = Number(attr(a, 'data-start'));
    const dur = Number(attr(a, 'data-duration'));
    if (!Number.isFinite(start) || !Number.isFinite(dur) || dur <= 0) continue;
    const src = attr(a, 'data-composition-src');
    const comment = (note?.[1] ?? '').replace(/\s+/g, ' ').trim();
    out.push({
      key: attr(a, 'id') || attr(a, 'data-composition-id') || src,
      start, end: start + dur,
      label: attr(a, 'data-composition-id') || basename(src, '.html'),
      intent: comment,
      onScreen: visibleText(readComposition(src)).slice(0, 220),
      anchor: attr(a, 'data-anchor') || undefined,
    });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Equal chunks when a project has no beat map. */
export function beatsByChunks(duration, every = 3) {
  const out = [];
  for (let t = 0, i = 1; t < duration - 0.05; t += every, i++) {
    out.push({ key: `part-${i}`, start: round2(t), end: round2(Math.min(duration, t + every)), label: `Part ${i}`, intent: '', onScreen: '' });
  }
  return out;
}

/** Words spoken inside [start, end) from a transcript with a words array. */
export function spokenIn(words, start, end) {
  return (words ?? []).filter((w) => w.start >= start - 0.05 && w.start < end).map((w) => w.text ?? w.word ?? '').join(' ').replace(/\s+([,.!?])/g, '$1').trim();
}

// ---------- review state ----------

/** 83.4 -> "1:23.4" */
export function fmtTime(t) {
  const n = Math.max(0, Number(t) || 0);
  const m = Math.floor(n / 60);
  const sec = (n - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${sec}`;
}

/** Merge freshly detected beats with saved review state, keeping decisions by beat key. */
export function mergeReview(saved, beats, meta = {}) {
  const prev = new Map((saved?.beats ?? []).map((b) => [b.key, b]));
  return {
    project: meta.project ?? saved?.project ?? '',
    video: meta.video ?? saved?.video ?? '',
    round: saved?.round ?? 1,
    updatedAt: saved?.updatedAt ?? null,
    beats: beats.map((b, i) => {
      const p = prev.get(b.key) ?? {};
      return {
        id: `b${String(i + 1).padStart(2, '0')}`,
        ...b,
        start: round2(b.start), end: round2(b.end),
        status: STATUSES.includes(p.status) ? p.status : 'waiting',
        newIdea: Boolean(p.newIdea),
        note: p.note ?? '',
        drawings: p.drawings ?? [],
        uploads: p.uploads ?? [],
        revisedInRound: p.revisedInRound,
        history: p.history ?? [],
      };
    }),
    comments: saved?.comments ?? [],
    amend: saved?.amend ?? null,
  };
}

/** Timeline mode: add a comment pinned to a timestamp. */
export function addComment(review, { time, text = '', drawing = null, attachments = [] }, now = new Date().toISOString()) {
  const t = Number(time);
  if (!Number.isFinite(t) || t < 0) throw new Error('Bad time');
  if (!String(text).trim() && !drawing && !attachments.length) throw new Error('Write a comment, draw, or attach something first');
  const n = review.comments.reduce((m, c) => Math.max(m, Number(c.id.slice(1)) || 0), 0) + 1;
  const c = { id: `c${String(n).padStart(2, '0')}`, time: round2(t), text: String(text).slice(0, 4000), drawing, attachments, done: false, round: review.round, at: now };
  review.comments.push(c);
  review.comments.sort((a, b) => a.time - b.time);
  review.updatedAt = now;
  return c;
}

export function updateComment(review, id, patch, now = new Date().toISOString()) {
  const c = review.comments.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown comment ${id}`);
  if (patch.text !== undefined) c.text = String(patch.text).slice(0, 4000);
  if (patch.done !== undefined) c.done = Boolean(patch.done);
  review.updatedAt = now;
  return c;
}

export function deleteComment(review, id, now = new Date().toISOString()) {
  const i = review.comments.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`Unknown comment ${id}`);
  review.comments.splice(i, 1);
  review.updatedAt = now;
}

/** Apply one card update from the board. */
export function applyUpdate(review, beatId, patch, now = new Date().toISOString()) {
  const beat = review.beats.find((b) => b.id === beatId);
  if (!beat) throw new Error(`Unknown beat ${beatId}`);
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw new Error(`Bad status ${patch.status}`);
    beat.status = patch.status;
    if (patch.status !== 'change') beat.newIdea = false;
  }
  if (patch.newIdea !== undefined) beat.newIdea = Boolean(patch.newIdea);
  if (patch.note !== undefined) beat.note = String(patch.note).slice(0, 4000);
  review.updatedAt = now;
  return beat;
}

export function summarize(review) {
  const count = (s) => review.beats.filter((b) => b.status === s).length;
  return { approved: count('approved'), change: count('change'), waiting: count('waiting'), total: review.beats.length };
}

/** After Claude fixes the flagged beats: archive their notes and send them back for review. */
export function markRevised(review, ids, now = new Date().toISOString()) {
  const want = new Set(ids);
  for (const c of review.comments ?? []) {
    if (!want.has(c.id)) continue;
    Object.assign(c, { done: true, resolvedInRound: review.round });
    want.delete(c.id);
  }
  const unknown = [...want].filter((id) => !review.beats.some((b) => b.id === id || b.key === id));
  if (unknown.length) throw new Error(`Unknown beats: ${unknown.join(', ')}`);
  for (const b of review.beats) {
    if (!want.has(b.id) && !want.has(b.key)) continue;
    b.history.push({ round: review.round, status: b.status, newIdea: b.newIdea, note: b.note, drawings: b.drawings, uploads: b.uploads, at: now });
    Object.assign(b, { status: 'waiting', newIdea: false, note: '', drawings: [], uploads: [], revisedInRound: review.round });
  }
  review.round += 1;
  review.amend = null;
  review.updatedAt = now;
  return review;
}

export function notesText(review) {
  const s = summarize(review);
  const comments = review.comments ?? [];
  if (comments.length && !s.change) {
    const open = comments.filter((c) => !c.done);
    const lines = [`${review.project}: round ${review.round}, ${open.length} open comments, ${comments.length - open.length} resolved`];
    for (const c of open) {
      lines.push(`- ${c.id} at ${fmtTime(c.time)} (${c.time}s): ${c.text || '(drawing only)'}`);
      if (c.drawing) lines.push(`    drawing: ${c.drawing}`);
      for (const a of c.attachments ?? []) lines.push(`    attachment: ${a.file}${a.name ? ` (${a.name})` : ''}`);
    }
    if (!open.length) lines.push('- No open comments.');
    return lines.join('\n');
  }
  const lines = [`${review.project}: round ${review.round}, ${s.approved} approved, ${s.change} to change, ${s.waiting} waiting`];
  for (const b of review.beats.filter((x) => x.status === 'change')) {
    lines.push(`- ${b.id} (${b.key}, ${b.start}s-${b.end}s)${b.newIdea ? ' NEW IDEA' : ''}: ${b.note || '(no note)'}`);
    for (const d of b.drawings) lines.push(`    drawing: ${d.file}${d.note ? ` "${d.note}"` : ''}`);
    for (const u of b.uploads) lines.push(`    reference: ${u.file}`);
  }
  if (!s.change) lines.push('- Nothing flagged for change.');
  return lines.join('\n');
}

// ---------- project loading ----------

function findVideo(dir) {
  const candidates = [];
  for (const sub of ['renders', '.']) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (/\.mp4$/i.test(f)) candidates.push(join(d, f));
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function probeDuration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number(r.stdout?.trim()) || null;
}

export function loadProject(dir, opts = {}) {
  dir = resolve(dir);
  const video = opts.video ? resolve(opts.video) : findVideo(dir);
  let beats = [];
  let source = '';
  const plan = readJson(join(dir, 'assets/plan.json'));
  if (!opts.every && plan?.scenes?.length) { beats = beatsFromPlan(plan); source = 'assets/plan.json'; }
  if (!opts.every && !beats.length && existsSync(join(dir, 'index.html'))) {
    const read = (src) => { try { return readFileSync(join(dir, src), 'utf8'); } catch { return ''; } };
    beats = beatsFromIndex(readFileSync(join(dir, 'index.html'), 'utf8'), read);
    source = 'index.html';
  }
  if (!beats.length && opts.mode === 'timeline') {
    if (!video) throw new Error(`No rendered video in ${dir}. Render a draft or pass --video.`);
    source = 'timeline';
  } else if (!beats.length) {
    const duration = video ? probeDuration(video) : null;
    if (!duration) throw new Error(`No beats found in ${dir} and no video to split. Add assets/plan.json or pass --video.`);
    beats = beatsByChunks(duration, Number(opts.every) || 3);
    source = `${Number(opts.every) || 3}s chunks`;
  }
  const words = readJson(join(dir, 'assets/transcript.json'))?.words;
  for (const b of beats) b.said = spokenIn(words, b.start, b.end);
  const reviewDir = join(dir, 'review');
  const reviewPath = join(reviewDir, 'REVIEW.json');
  const review = mergeReview(readJson(reviewPath), beats, { project: basename(dir), video: video ? relative(dir, video).split(sep).join('/') : '' });
  const precheck = readJson(join(reviewDir, 'precheck.json'))?.beats ?? {};
  const duration = video ? probeDuration(video) : null;
  return { dir, video, duration, source, review, reviewDir, reviewPath, precheck, mode: opts.mode === 'timeline' ? 'timeline' : 'beats' };
}

function save(p) {
  mkdirSync(p.reviewDir, { recursive: true });
  writeFileSync(p.reviewPath, JSON.stringify(p.review, null, 2) + '\n');
}

// ---------- board page ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function boardHtml(p, base) {
  const data = JSON.stringify({ review: p.review, precheck: p.precheck, base, source: p.source }).replace(/</g, '\\u003c');
  const videoUrl = p.review.video ? `${base}media/${p.review.video.split('/').map(encodeURIComponent).join('/')}` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review: ${esc(p.review.project)}</title>
<style>
:root{--bg:#101318;--panel:#181c23;--line:#2a303a;--text:#e9edf2;--dim:#93a0b0;--ok:#3fbf6f;--chg:#f0a63a;--wait:#6f8cff;--flag:#ff6b6b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{position:sticky;top:0;z-index:5;background:#0c0f13ee;border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
header h1{font-size:16px;margin:0}.counts{display:flex;gap:14px;font-weight:600}.counts .a{color:var(--ok)}.counts .c{color:var(--chg)}.counts .w{color:var(--wait)}
.bar{display:flex;gap:3px;flex:1;min-width:160px}.bar span{flex:1;height:8px;border-radius:4px;background:var(--wait);cursor:pointer}.bar span.approved{background:var(--ok)}.bar span.change{background:var(--chg)}
button{font:inherit;color:var(--text);background:#232934;border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}button:hover{border-color:#4a5568}
button.approve.on{background:var(--ok);color:#06210f;border-color:var(--ok)}button.change.on{background:var(--chg);color:#2b1a00;border-color:var(--chg)}button.idea.on{border-color:var(--chg);color:var(--chg)}
main{display:grid;grid-template-columns:minmax(260px,380px) 1fr;gap:20px;padding:16px;max-width:1500px;margin:auto}
.player{position:sticky;top:70px;align-self:start}.player video{width:100%;max-height:75vh;background:#000;border-radius:10px}
.help{color:var(--dim);font-size:13px;margin-top:10px}.help code{color:var(--text)}
.card{background:var(--panel);border:1px solid var(--line);border-left:5px solid var(--wait);border-radius:12px;padding:14px;margin-bottom:16px;display:grid;grid-template-columns:minmax(160px,260px) 1fr;gap:16px}
.card.approved{border-left-color:var(--ok)}.card.change{border-left-color:var(--chg)}
.card video{width:100%;max-height:340px;background:#000;border-radius:8px}
.tag{display:inline-block;font-weight:700;background:#2b3240;border-radius:6px;padding:1px 8px;margin-right:6px}.time{color:var(--dim);font-size:13px}
.chip{float:right;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:20px;padding:2px 10px;background:#25305a;color:#b8c6ff}.chip.approved{background:#123d22;color:#8ff0b0}.chip.change{background:#4a3208;color:#ffd08a}
.field{margin:6px 0}.field b{color:var(--dim);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;display:block}
.flag{background:#3a1717;border:1px solid #6b2a2a;border-radius:8px;padding:6px 10px;margin:6px 0}.flag.ok{background:#14301f;border-color:#245c38}
textarea{width:100%;min-height:64px;background:#0f1216;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit;resize:vertical}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.saved{color:var(--dim);font-size:12px}
.thumbs{display:flex;gap:6px;flex-wrap:wrap}.thumbs img{height:70px;border-radius:6px;border:1px solid var(--line)}
.history{color:var(--dim);font-size:13px}.dim{color:var(--dim);font-size:13px}button.primary{background:var(--chg);color:#2b1a00;border-color:var(--chg);font-weight:600}
dialog{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:12px;max-width:95vw}dialog canvas{max-width:85vw;max-height:70vh;cursor:crosshair;border-radius:8px;display:block}
@media(max-width:860px){header{position:static}main{grid-template-columns:1fr}.player{position:static}.card{grid-template-columns:1fr}}
</style></head><body>
<header><h1>Review: ${esc(p.review.project)}</h1><div class="counts"><span class="a" id="nA"></span><span class="c" id="nC"></span><span class="w" id="nW"></span></div>
<div class="bar" id="bar"></div><button id="next">Next to review ↓</button>${finishButtons(p.review)}</header>
<main><div class="player">${videoUrl ? `<video id="main" src="${esc(videoUrl)}" controls playsinline preload="metadata"></video>` : '<p>No rendered video found. Render a draft first.</p>'}
<p class="help">Watch each beat, then press <b>Approve</b> or <b>Change</b> and say what to change. <b>Draw</b> lets you mark the frame. Notes save by themselves.<br>When you're done, tell Claude: <code>I left review notes on ${esc(p.review.project)}, let's amend.</code></p>
<p class="help">Round ${p.review.round} · beats from ${esc(p.source)}${base !== '/' ? ' · <a href="/" style="color:inherit">all videos</a>' : ''}</p></div>
<section id="cards"></section></main>
<dialog id="draw"><div class="row"><b id="drawTitle"></b><span style="flex:1"></span>Colour <input type="color" id="pen" value="#ff3b30"><button id="undo">Undo</button></div>
<canvas id="canvas"></canvas><textarea id="drawNote" placeholder="What should change here? (for example: make it yellow)"></textarea>
<div class="row"><button class="approve on" id="drawSave">Save to the sheet</button><button id="drawCancel">Cancel</button></div></dialog>
<script>
const S=${data};const R=S.review;const base=S.base;const media=${JSON.stringify(videoUrl)};
const $=(q,el=document)=>el.querySelector(q);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());return r.json();}
function counts(){const c={approved:0,change:0,waiting:0};R.beats.forEach(b=>c[b.status]++);$('#nA').textContent=c.approved+' approved';$('#nC').textContent=c.change+' to change';$('#nW').textContent=c.waiting+' waiting';
$('#bar').innerHTML=R.beats.map(b=>'<span class="'+b.status+'" title="'+b.id+'" data-id="'+b.id+'"></span>').join('');}
function card(b){const pc=S.precheck[b.key]||S.precheck[b.id];const el=document.createElement('article');el.className='card '+b.status;el.id=b.id;
el.innerHTML='<div>'+(media?'<video src="'+media+'#t='+b.start+','+b.end+'" preload="metadata" playsinline controls muted></video>':'')+'<div class="row"><button class="jump">Play in big player</button></div></div>'+
'<div><span class="chip '+b.status+'">'+(b.status==='change'?(b.newIdea?'new idea asked':'change asked'):b.status)+'</span><span class="tag">'+b.id+'</span><span class="time">'+b.start.toFixed(2)+'s to '+b.end.toFixed(2)+'s · '+esc(b.label)+'</span>'+
(b.revisedInRound?'<span class="time"> · revised after round '+b.revisedInRound+'</span>':'')+
(pc?'<div class="flag '+(pc.level==='ok'?'ok':'')+'"><b>Claude\\'s check:</b> '+esc(pc.note)+'</div>':'')+
(b.said?'<div class="field"><b>What is said</b>'+esc(b.said)+'</div>':'')+(b.onScreen?'<div class="field"><b>On screen</b>'+esc(b.onScreen)+'</div>':'')+(b.intent?'<div class="field"><b>Plan for this beat</b>'+esc(b.intent)+'</div>':'')+
'<div class="row"><button class="approve '+(b.status==='approved'?'on':'')+'">✓ Approve</button><button class="change '+(b.status==='change'&&!b.newIdea?'on':'')+'">✎ Change</button><button class="draw">Draw</button><button class="upload">Upload reference</button><button class="idea '+(b.newIdea?'on':'')+'">New idea</button></div>'+
'<textarea placeholder="What should this beat be instead?">'+esc(b.note)+'</textarea><div class="saved"></div>'+
'<div class="thumbs">'+b.drawings.concat(b.uploads).map(d=>'<a href="'+base+'media/'+d.file+'" target="_blank"><img src="'+base+'media/'+d.file+'" alt=""></a>').join('')+'</div>'+
(b.history.length?'<details class="history"><summary>Earlier notes ('+b.history.length+')</summary>'+b.history.map(h=>'<div>Round '+h.round+': '+esc(h.status)+(h.note?' · '+esc(h.note):'')+'</div>').join('')+'</details>':'')+'</div>';
const v=$('video',el);if(v){v.addEventListener('loadedmetadata',()=>{if(v.paused)v.currentTime=b.start+Math.min(1.5,(b.end-b.start)/2);},{once:true});v.addEventListener('timeupdate',()=>{if(v.currentTime>=b.end-0.03){v.currentTime=b.start;}});v.addEventListener('play',()=>{if(v.currentTime<b.start||v.currentTime>=b.end)v.currentTime=b.start;});}
$('.jump',el).onclick=()=>{const m=$('#main');if(m){m.currentTime=b.start;m.play();}};
const ta=$('textarea',el);let t;ta.oninput=()=>{clearTimeout(t);$('.saved',el).textContent='…';t=setTimeout(()=>update(b,{note:ta.value}),600);};
$('.approve',el).onclick=()=>update(b,{status:b.status==='approved'?'waiting':'approved',note:ta.value},true);
$('.change',el).onclick=()=>{update(b,{status:'change',newIdea:false,note:ta.value},true);};
$('.idea',el).onclick=()=>update(b,{status:'change',newIdea:!b.newIdea,note:ta.value},true);
$('.draw',el).onclick=()=>openDraw(b,v);
$('.upload',el).onclick=()=>{const i=document.createElement('input');i.type='file';i.accept='image/*';i.onchange=async()=>{const f=i.files[0];if(!f)return;const url=await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(f);});const res=await post('upload',{beat:b.id,name:f.name,dataUrl:url});Object.assign(b,res.beat);if(b.status!=='change')await update(b,{status:'change',note:ta.value});render();};i.click();};
return el;}
async function update(b,patch,rerender){try{const res=await post('save',{beat:b.id,patch});Object.assign(b,res.beat);const s=document.getElementById(b.id);if(s)$('.saved',s).textContent='Saved';}catch(e){alert('Could not save: '+e.message);}counts();if(rerender)render(b.id);}
function render(focus){const c=$('#cards');const y=scrollY;c.innerHTML='';R.beats.forEach(b=>c.appendChild(card(b)));counts();scrollTo(0,y);}
$('#bar').onclick=e=>{const id=e.target.dataset.id;if(id)document.getElementById(id).scrollIntoView({behavior:'smooth',block:'center'});};
$('#next').onclick=()=>{const b=R.beats.find(x=>x.status==='waiting');if(b)document.getElementById(b.id).scrollIntoView({behavior:'smooth',block:'center'});};
${FINISH_JS}
// drawing
let strokes=[],cur=null,drawBeat=null,bg=null;const cv=$('#canvas'),ctx=cv.getContext('2d');
function openDraw(b,v){drawBeat=b;strokes=[];$('#drawTitle').textContent='Draw on '+b.id+' (pause the clip on the frame you want first)';$('#drawNote').value='';
const w=v&&v.videoWidth?v.videoWidth:1080,h=v&&v.videoHeight?v.videoHeight:1920;cv.width=w;cv.height=h;bg=document.createElement('canvas');bg.width=w;bg.height=h;
const g=bg.getContext('2d');g.fillStyle='#222';g.fillRect(0,0,w,h);if(v&&v.readyState>=2)g.drawImage(v,0,0,w,h);redraw();$('#draw').showModal();}
function redraw(){ctx.drawImage(bg,0,0);ctx.lineCap='round';ctx.lineJoin='round';ctx.lineWidth=Math.max(4,cv.width/150);for(const s of strokes){ctx.strokeStyle=s.c;ctx.beginPath();s.p.forEach((q,i)=>i?ctx.lineTo(q[0],q[1]):ctx.moveTo(q[0],q[1]));ctx.stroke();}}
function pos(e){const r=cv.getBoundingClientRect();return[(e.clientX-r.left)*cv.width/r.width,(e.clientY-r.top)*cv.height/r.height];}
cv.onpointerdown=e=>{cur={c:$('#pen').value,p:[pos(e)]};strokes.push(cur);cv.setPointerCapture(e.pointerId);};
cv.onpointermove=e=>{if(cur){cur.p.push(pos(e));redraw();}};cv.onpointerup=()=>{cur=null;};
$('#undo').onclick=()=>{strokes.pop();redraw();};$('#drawCancel').onclick=()=>$('#draw').close();
$('#drawSave').onclick=async()=>{$('#drawSave').textContent='Saving…';try{const res=await post('drawing',{beat:drawBeat.id,note:$('#drawNote').value,dataUrl:cv.toDataURL('image/png')});Object.assign(drawBeat,res.beat);$('#draw').close();render();}catch(e){alert('Could not save: '+e.message);}$('#drawSave').textContent='Save to the sheet';};
render();
</script></body></html>`;
}

/** Header buttons shared by both views: finish the review without going back to Claude. */
function finishButtons(review) {
  const a = review.amend;
  const label = a?.state === 'approved' ? 'Approved' : a?.state === 'amended' ? 'Amended, new draft loaded' : '';
  return `<span class="dim" id="finishState">${esc(label)}</span><button id="approveAll">✓ Approve video</button><button class="primary" id="sendAmend">Send notes for amend</button>
<div id="amendPanel" style="display:none;position:fixed;right:16px;bottom:16px;width:min(440px,92vw);max-height:60vh;overflow:auto;z-index:20;background:#181c23;border:1px solid #2a303a;border-radius:12px;padding:12px 14px;box-shadow:0 8px 30px #0008">
<div style="display:flex;gap:8px;align-items:center"><b id="amendTitle">Claude is amending…</b><span style="flex:1"></span><button id="amendStop">Stop</button><button id="amendHide">Hide</button></div>
<ol id="amendSteps" style="margin:8px 0 0;padding-left:20px;color:#93a0b0;font-size:13px"></ol><p id="amendResult" style="white-space:pre-wrap;margin:8px 0 0"></p>
<button id="amendReload" class="primary" style="display:none;margin-top:8px">Load the new draft</button></div>`;
}
const FINISH_JS = `
const AP=document.getElementById('amendPanel');let apTimer=null;
function showAmend(j){if(!j||j.state==='idle')return;AP.style.display='block';
const T={running:'Claude is amending your notes…',done:'Amend finished',failed:'Amend stopped with a problem',stopped:'Amend stopped'};
document.getElementById('amendTitle').textContent=T[j.state]||j.state;document.getElementById('amendStop').style.display=j.state==='running'?'':'none';
document.getElementById('amendSteps').innerHTML=(j.steps||[]).slice(-12).map(s=>'<li>'+String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</li>').join('');
document.getElementById('amendResult').textContent=j.state==='running'?'':(j.result||'');
document.getElementById('amendReload').style.display=j.state==='done'?'':'none';
if(j.state==='running'){clearTimeout(apTimer);apTimer=setTimeout(pollAmend,3000);}}
async function pollAmend(){try{showAmend(await (await fetch(base+'amend-status',{cache:'no-store'})).json());}catch(e){apTimer=setTimeout(pollAmend,5000);}}
async function finish(kind){const msg=kind==='amend'?'Send your notes to Claude now? It fixes them in the background and the new draft loads here when it is done.':'Approve this video with no changes?';if(!confirm(msg))return;
try{const r=await fetch(base+'finish',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({kind})});const j=await r.json();if(!r.ok)throw new Error(j.error||'failed');
document.getElementById('finishState').textContent=j.message;if(kind==='amend')pollAmend();}catch(e){alert('Could not send: '+e.message);}}
document.getElementById('sendAmend').onclick=()=>finish('amend');document.getElementById('approveAll').onclick=()=>finish('approve');
document.getElementById('amendHide').onclick=()=>{AP.style.display='none';};
document.getElementById('amendStop').onclick=async()=>{if(confirm('Stop the amend?')){await fetch(base+'amend-stop',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});pollAmend();}};
document.getElementById('amendReload').onclick=()=>location.reload();
pollAmend();`;

// ---------- shared look (gallery + player) ----------

const THEME_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
:root{--bg:#12141e;--panel:#1a1d2a;--card:#1f2332;--hover:#262a3b;--line:rgba(255,255,255,.07);--text:rgba(243,243,247,.92);--dim:rgba(189,192,212,.72);--faint:rgba(189,192,212,.45);
--accent:#5b53ff;--accent2:#7a73ff;--ok:#3ecf8e;--warn:#f5a524;--tc:#f0c34a;--danger:#ff5a5f}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:400 13px/1.45 Inter,system-ui,-apple-system,Segoe UI,sans-serif;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
button{font:500 12px Inter,system-ui,sans-serif;color:var(--text);background:var(--hover);border:1px solid transparent;border-radius:6px;padding:6px 10px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
button:hover{background:#2e3347}button.accent{background:var(--accent);color:#fff}button.accent:hover{background:var(--accent2)}
button.ghost{background:transparent;color:var(--dim)}button.ghost:hover{background:var(--hover);color:var(--text)}button:disabled{opacity:.5;cursor:default}
.top{height:48px;display:flex;align-items:center;gap:10px;padding:0 14px;border-bottom:1px solid var(--line);background:#0f111a}
.crumb{display:flex;align-items:center;gap:6px;color:var(--dim);font-size:13px;min-width:0}.crumb b{color:var(--text);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp{flex:1}.icon{width:16px;height:16px;flex:none}
.chip{display:inline-flex;align-items:center;gap:5px;font:500 11px Inter,sans-serif;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.08);color:var(--dim);white-space:nowrap}
.chip i{width:6px;height:6px;border-radius:50%;background:currentColor}
.chip.ok{color:var(--ok);background:rgba(62,207,142,.12)}.chip.warn{color:var(--warn);background:rgba(245,165,36,.12)}.chip.run{color:var(--accent2);background:rgba(91,83,255,.16)}.chip.bad{color:var(--danger);background:rgba(255,90,95,.12)}
`;
const ICONS = {
  grid: '<svg class="icon" viewBox="0 0 16 16" fill="currentColor"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1"/><rect x="9" y="9" width="5.5" height="5.5" rx="1"/></svg>',
  list: '<svg class="icon" viewBox="0 0 16 16" fill="currentColor"><rect x="1.5" y="2.5" width="13" height="2.2" rx="1"/><rect x="1.5" y="6.9" width="13" height="2.2" rx="1"/><rect x="1.5" y="11.3" width="13" height="2.2" rx="1"/></svg>',
  back: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3 5 8l5 5"/></svg>',
  next: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3 5 5-5 5"/></svg>',
  clip: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M10.5 4.5 5.3 9.7a1.6 1.6 0 0 0 2.3 2.3l5.4-5.4a3 3 0 0 0-4.3-4.3L3.3 7.7a4.4 4.4 0 0 0 6.2 6.2L13 10.4"/></svg>',
  pen: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m10.5 2.5 3 3L6 13H3v-3z"/></svg>',
  send: '<svg class="icon" viewBox="0 0 16 16" fill="currentColor"><path d="M1.8 1.9 14.6 8 1.8 14.1l1.6-5.3L9 8 3.4 7.2z"/></svg>',
  check: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 8.5 3 3 7-7"/></svg>',
  chat: '<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/></svg>',
};
const nice = (slug) => String(slug).replace(/^_+/, '').replace(/[-_]+/g, ' ').trim();
const fmtDur = (d) => { if (!d) return ''; const m = Math.floor(d / 60); return `${String(m).padStart(2, '0')}:${String(Math.round(d - m * 60)).padStart(2, '0')}`; };

/** Status shown on cards, rows and the player header. */
function statusOf(p) {
  const open = (p.review.comments ?? []).filter((c) => !c.done).length + p.review.beats.filter((b) => b.status === 'change').length;
  const st = p.review.amend?.state;
  if (st === 'sent') return { cls: 'run', text: 'Amending' };
  if (st === 'failed') return { cls: 'bad', text: 'Amend failed' };
  if (st === 'approved') return { cls: 'ok', text: 'Approved' };
  if (open) return { cls: 'warn', text: `${open} to change` };
  if (st === 'amended' || p.review.round > 1) return { cls: '', text: 'New draft' };
  return { cls: '', text: 'Needs review' };
}

/** Gallery of every video in the batch: thumbnails, Grid / List switch, status. */
function indexHtml(projects) {
  const items = projects.map((p, i) => {
    const s = statusOf(p);
    const comments = (p.review.comments ?? []).length;
    const draft = p.review.video ? basename(p.review.video, extname(p.review.video)) : 'No render yet';
    return { i, name: nice(p.review.project), draft, round: p.review.round, comments, dur: fmtDur(p.duration), s, updated: p.review.updatedAt };
  });
  const card = (x) => `<a class="card" href="/p/${x.i}/"><div class="thumb"><img loading="lazy" src="/p/${x.i}/thumb.jpg" alt=""><span class="dur">${esc(x.dur)}</span>
<span class="chip ${x.s.cls} st"><i></i>${esc(x.s.text)}</span></div>
<div class="meta"><div class="name" title="${esc(x.name)}">${esc(x.name)}</div><div class="sub">${esc(x.draft)} · Round ${x.round}</div>
<div class="foot"><span>${ICONS.chat} ${x.comments}</span></div></div></a>`;
  const row = (x) => `<a class="row" href="/p/${x.i}/"><div class="rthumb"><img loading="lazy" src="/p/${x.i}/thumb.jpg" alt=""></div>
<div class="rname"><b>${esc(x.name)}</b><span>${esc(x.draft)}</span></div><div><span class="chip ${x.s.cls}"><i></i>${esc(x.s.text)}</span></div>
<div class="rc">${ICONS.chat} ${x.comments}</div><div class="rc">Round ${x.round}</div><div class="rc">${esc(x.dur)}</div></a>`;
  const approved = items.filter((x) => x.s.cls === 'ok').length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review · ${projects.length} videos</title>
<style>${THEME_CSS}
.hero{padding:22px 24px 10px;background:linear-gradient(180deg,rgba(91,83,255,.18),rgba(91,83,255,0) 120px)}
.hero h1{font:600 24px Inter,sans-serif;margin:0 0 4px;letter-spacing:-.01em}.hero p{margin:0;color:var(--dim)}
.bar{display:flex;align-items:center;gap:10px;padding:10px 24px;color:var(--dim)}
.seg{display:inline-flex;background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:2px}.seg button{background:transparent;color:var(--dim);padding:5px 9px}.seg button.on{background:var(--hover);color:var(--text)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;padding:6px 24px 32px}
.card{background:var(--card);border-radius:8px;overflow:hidden;border:1px solid transparent;transition:border-color .15s,background .15s}.card:hover{background:var(--hover);border-color:rgba(122,115,255,.45)}
.thumb{position:relative;aspect-ratio:1/1;background:#000;display:flex;align-items:center;justify-content:center}.thumb img{max-width:100%;max-height:100%;object-fit:contain;display:block}
.dur{position:absolute;right:8px;bottom:8px;background:#000;color:#fff;font:500 11px Inter,sans-serif;padding:2px 5px;border-radius:4px}
.st{position:absolute;left:8px;top:8px;backdrop-filter:blur(6px)}
.meta{padding:10px 12px 12px}.name{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.sub{color:var(--dim);font-size:12px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.foot{display:flex;gap:10px;margin-top:10px;padding-top:8px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}.foot span{display:inline-flex;align-items:center;gap:5px}
.list{padding:6px 24px 32px}.lhead,.row{display:grid;grid-template-columns:96px minmax(0,1fr) 140px 70px 80px 60px;gap:14px;align-items:center}
.lhead{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:0 10px 8px;border-bottom:1px solid var(--line)}
.row{padding:8px 10px;border-radius:8px}.row:hover{background:var(--hover)}.rthumb{width:96px;aspect-ratio:16/9;background:#000;border-radius:5px;overflow:hidden;display:flex;align-items:center;justify-content:center}.rthumb img{max-width:100%;max-height:100%}
.rname{min-width:0;display:flex;flex-direction:column}.rname b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rname span{color:var(--dim);font-size:12px}
.rc{color:var(--dim);display:inline-flex;align-items:center;gap:5px}
[hidden]{display:none!important}
@media(max-width:700px){.lhead,.row{grid-template-columns:72px minmax(0,1fr) auto}.lhead div:nth-child(n+4),.row .rc{display:none}.rthumb{width:72px}}
</style></head><body>
<div class="top"><div class="crumb"><b>Review</b></div><span class="sp"></span></div>
<div class="hero"><h1>Review</h1><p>${projects.length} video${projects.length === 1 ? '' : 's'} · ${approved} approved</p></div>
<div class="bar"><span>Open a video to comment, approve, or send notes for amend.</span><span class="sp"></span>
<div class="seg" role="group" aria-label="Layout"><button id="vGrid" title="Grid">${ICONS.grid} Grid</button><button id="vList" title="List">${ICONS.list} List</button></div></div>
<div class="grid" id="grid">${items.map(card).join('')}</div>
<div class="list" id="list" hidden><div class="lhead"><div></div><div>Name</div><div>Status</div><div>Comments</div><div>Round</div><div>Length</div></div>${items.map(row).join('')}</div>
<script>
const set=v=>{document.getElementById('grid').hidden=v!=='grid';document.getElementById('list').hidden=v!=='list';document.getElementById('vGrid').classList.toggle('on',v==='grid');document.getElementById('vList').classList.toggle('on',v==='list');try{localStorage.setItem('reviewLayout',v)}catch(e){}};
let v=new URLSearchParams(location.search).get('view');if(!v){try{v=localStorage.getItem('reviewLayout')}catch(e){}}set(v==='list'?'list':'grid');
document.getElementById('vGrid').onclick=()=>set('grid');document.getElementById('vList').onclick=()=>set('list');
</script></body></html>`;
}

/** Player: video on the left, comments sidebar on the right, comments pinned to timestamps. */
export function timelineHtml(p, base, nav = { i: 0, n: 1 }) {
  const data = JSON.stringify({ review: p.review, base }).replace(/</g, '\\u003c');
  const videoUrl = p.review.video ? `${base}media/${p.review.video.split('/').map(encodeURIComponent).join('/')}` : '';
  const s = statusOf(p);
  const many = nav.n > 1;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(nice(p.review.project))} · Review</title>
<style>${THEME_CSS}
html,body{height:100%}body{display:flex;flex-direction:column;overflow:hidden}
.wrap{flex:1;display:grid;grid-template-columns:minmax(0,1fr) 360px;grid-template-rows:minmax(0,1fr);min-height:0}
.left{display:flex;flex-direction:column;min-width:0;min-height:0;background:#000}
.stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;background:#000}
#v{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;background:#000}
#ov{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}.stage.drawing #ov{pointer-events:auto;cursor:crosshair}.stage.drawing{outline:2px solid var(--danger);outline-offset:-2px}
.tools{display:none;align-items:center;gap:8px;padding:6px 14px;background:#0f111a;border-top:1px solid var(--line);color:var(--dim)}.tools.on{display:flex}
.ctrl{background:#0f111a;border-top:1px solid var(--line);padding:8px 14px 10px}
.track{position:relative;height:16px;cursor:pointer;display:flex;align-items:center}.track .rail{position:absolute;left:0;right:0;height:4px;border-radius:2px;background:#2a2f42}
.track .played{position:absolute;left:0;height:4px;border-radius:2px;background:var(--accent)}.track .head{position:absolute;top:1px;width:14px;height:14px;margin-left:-7px;border-radius:50%;background:#fff;box-shadow:0 1px 4px #0008}
.track .pin{position:absolute;top:-6px;width:8px;height:8px;margin-left:-4px;border-radius:50%;background:var(--tc);border:1.5px solid #0f111a;cursor:pointer}.track .pin.done{background:var(--ok)}
.crow{display:flex;align-items:center;gap:10px;margin-top:8px}.tcode{font:500 13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:4px 10px;letter-spacing:.02em}
.side{display:flex;flex-direction:column;min-height:0;background:var(--panel);border-left:1px solid var(--line)}
.tabs{display:flex;gap:4px;padding:10px 12px 0}.tabs div{flex:1;text-align:center;padding:6px;border-radius:6px;background:var(--card);font-weight:500;font-size:12px}
.shead{display:flex;align-items:center;gap:8px;padding:12px 14px 6px;font-weight:600}.shead .sp{flex:1}.shead small{color:var(--dim);font-weight:400}
.clist{flex:1;overflow:auto;padding:4px 8px}
.empty{color:var(--dim);text-align:center;padding:40px 20px}.empty svg{width:40px;height:40px;opacity:.5;display:block;margin:0 auto 10px}
.c{padding:10px;border-radius:8px;margin-bottom:2px;cursor:pointer}.c:hover{background:var(--hover)}.c.now{background:rgba(91,83,255,.14)}.c.done{opacity:.55}
.c .h{display:flex;align-items:center;gap:8px}.av{width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;font:600 11px Inter,sans-serif;display:flex;align-items:center;justify-content:center;flex:none}
.c .who{font-weight:600}.c .when{color:var(--faint);font-size:11px}.c .t{font:500 11px ui-monospace,Consolas,monospace;color:#1a1300;background:var(--tc);border-radius:4px;padding:1px 5px;margin-right:6px}
.c .t.done{background:var(--ok)}.c p{margin:6px 0 0 30px;white-space:pre-wrap;word-break:break-word}
.c img,.c video{max-width:calc(100% - 30px);max-height:170px;object-fit:contain;background:#000;margin:8px 0 0 30px;border-radius:6px;display:block;border:1px solid var(--line)}
.c .att{display:inline-flex;align-items:center;gap:6px;margin:6px 0 0 30px;color:var(--accent2);font-size:12px}
.c .acts{display:none;gap:4px;margin:8px 0 0 26px}.c:hover .acts{display:flex}.c .acts button{padding:3px 8px;font-size:11px}
.composer{border-top:1px solid var(--line);padding:10px 12px 12px}
.box{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px}.box:focus-within{border-color:rgba(122,115,255,.6)}
.box .tc{font:500 11px ui-monospace,Consolas,monospace;color:#1a1300;background:var(--tc);border-radius:4px;padding:1px 6px}
textarea{width:100%;min-height:44px;max-height:160px;background:transparent;color:var(--text);border:0;outline:0;resize:none;font:400 13px/1.4 Inter,sans-serif;margin-top:6px;padding:0}
textarea::placeholder{color:var(--faint)}
.brow{display:flex;align-items:center;gap:4px;margin-top:6px}.brow .msg{color:var(--dim);font-size:11px;margin-left:4px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}.fchip{background:var(--hover);border-radius:999px;padding:2px 9px;font-size:11px}.fchip b{cursor:pointer;margin-left:6px;color:var(--dim)}
#amendPanel{position:fixed;right:376px;bottom:16px;width:min(420px,60vw);max-height:55vh;overflow:auto;z-index:20;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;box-shadow:0 10px 40px #000a;display:none}
#amendPanel ol{margin:8px 0 0;padding-left:18px;color:var(--dim);font-size:12px}#amendPanel p{white-space:pre-wrap;margin:8px 0 0}
@media(max-width:900px){body{overflow:auto;height:auto}.wrap{grid-template-columns:1fr}.stage{height:56vh;flex:none}.side{min-height:60vh}#amendPanel{right:12px}}
</style></head><body>
<div class="top">${many ? `<a href="/" title="All videos"><button class="ghost">${ICONS.back}</button></a>` : ''}
<div class="crumb">${many ? '<a href="/">Review</a><span>/</span>' : ''}<b>${esc(nice(p.review.project))}</b><span class="chip ${s.cls}" id="stChip"><i></i>${esc(s.text)}</span></div><span class="sp"></span>
${many ? `<span class="crumb" style="gap:2px">${nav.i > 0 ? `<a href="/p/${nav.i - 1}/"><button class="ghost">${ICONS.back}</button></a>` : '<button class="ghost" disabled>' + ICONS.back + '</button>'}<span style="padding:0 4px">${nav.i + 1} of ${nav.n}</span>${nav.i < nav.n - 1 ? `<a href="/p/${nav.i + 1}/"><button class="ghost">${ICONS.next}</button></a>` : '<button class="ghost" disabled>' + ICONS.next + '</button>'}</span>` : ''}
<span class="crumb" id="finishState"></span><button id="approveAll">${ICONS.check} Approve</button><button class="accent" id="sendAmend">Send for amend</button></div>
<div class="wrap"><section class="left">
<div class="stage" id="stage">${videoUrl ? `<video id="v" src="${esc(videoUrl)}" playsinline preload="metadata"></video><canvas id="ov"></canvas>` : '<p style="color:var(--dim)">No rendered video found. Render a draft first.</p>'}</div>
<div class="tools" id="tools"><b style="color:var(--text)">Drawing</b><span>Draw on the frame, then write your comment and send.</span><span class="sp"></span>Colour <input type="color" id="pen" value="#ff3b30"><button id="undo">Undo</button><button id="clear">Clear</button><button id="drawDone">Done</button></div>
<div class="ctrl"><div class="track" id="track"><div class="rail"></div><div class="played" id="played"></div><div class="head" id="head"></div></div>
<div class="crow"><button class="ghost" id="play" title="Play / pause (Space)"><svg class="icon" viewBox="0 0 16 16" fill="currentColor" id="playIco"><path d="M4 2.5v11l9-5.5z"/></svg></button>
<button class="ghost" id="rate">1.0x</button><button class="ghost" id="mute" title="Mute">🔊</button><span class="sp"></span><span class="tcode" id="tc">00:00:00:00</span><span class="sp"></span>
<button class="ghost" id="fs" title="Full screen">⛶</button></div></div>
</section>
<aside class="side"><div class="tabs"><div>Comments</div></div><div class="shead">All comments <small id="counts"></small><span class="sp"></span></div>
<div class="clist" id="list"></div>
<div class="composer"><div class="box"><span class="tc" id="at">00:00:00:00</span>
<textarea id="text" placeholder="Leave your comment…"></textarea><div class="chips" id="chips"></div>
<div class="brow"><button class="ghost" id="attachBtn" title="Attach files">${ICONS.clip}</button><button class="ghost" id="drawBtn" title="Draw on frame">${ICONS.pen}</button><span class="msg" id="msg"></span><span class="sp"></span><button class="accent" id="post" title="Send (Ctrl+Enter)">${ICONS.send}</button></div></div></div>
</aside></div>
<div id="amendPanel"><div style="display:flex;gap:8px;align-items:center"><b id="amendTitle">Claude is amending…</b><span class="sp"></span><button id="amendStop">Stop</button><button class="ghost" id="amendHide">Hide</button></div>
<ol id="amendSteps"></ol><p id="amendResult"></p><button id="amendReload" class="accent" style="display:none;margin-top:8px">Load the new draft</button></div>
<script>
const S=${data};const R=S.review;const base=S.base;const FPS=30;
const $=q=>document.querySelector(q);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const tc=t=>{t=Math.max(0,t||0);const h=Math.floor(t/3600),m=Math.floor(t/60)%60,s=Math.floor(t)%60,f=Math.floor((t%1)*FPS);return [h,m,s,f].map(n=>String(n).padStart(2,'0')).join(':');};
const ago=iso=>{if(!iso)return'';const d=(Date.now()-new Date(iso))/1000;return d<60?'just now':d<3600?Math.floor(d/60)+'m ago':d<86400?Math.floor(d/3600)+'h ago':Math.floor(d/86400)+'d ago';};
const v=$('#v');let pinTime=0;
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());const j=await r.json();R.comments=j.comments;render();return j;}
const busy=()=>document.activeElement===$('#text')||$('#stage').classList.contains('drawing');
function setAt(){pinTime=v?v.currentTime:0;$('#at').textContent=tc(pinTime);}
function render(){const open=R.comments.filter(c=>!c.done).length;$('#counts').textContent=open+' open · '+(R.comments.length-open)+' resolved';
const d=v&&v.duration||0;$('#track').querySelectorAll('.pin').forEach(e=>e.remove());
if(d)R.comments.forEach(c=>{const e=document.createElement('div');e.className='pin'+(c.done?' done':'');e.style.left=(c.time/d*100)+'%';e.title=tc(c.time)+'  '+c.text;e.onclick=ev=>{ev.stopPropagation();seek(c.time);};$('#track').appendChild(e);});
$('#list').innerHTML=R.comments.length?R.comments.map(c=>'<div class="c'+(c.done?' done':'')+'" id="'+c.id+'" data-t="'+c.time+'"><div class="h"><span class="av">Y</span><span class="who">You</span><span class="when">'+ago(c.at)+(c.round>1?' · round '+c.round:'')+'</span></div>'+
'<p><span class="t'+(c.done?' done':'')+'">'+tc(c.time)+'</span>'+esc(c.text)+'</p>'+
(c.attachments||[]).map(a=>{const u=base+'media/'+a.file;return /\\.(png|jpe?g|gif|webp)$/i.test(a.file)?'<a href="'+u+'" target="_blank"><img src="'+u+'" alt=""></a>':/\\.(mp4|webm|mov)$/i.test(a.file)?'<video src="'+u+'" controls preload="metadata"></video>':'<a class="att" href="'+u+'" target="_blank">📎 '+esc(a.name||a.file)+'</a>';}).join('')+
(c.drawing?'<a href="'+base+'media/'+c.drawing+'" target="_blank"><img src="'+base+'media/'+c.drawing+'" alt="drawing"></a>':'')+
'<div class="acts"><button data-done="'+c.id+'">'+(c.done?'Reopen':'Resolve')+'</button><button data-edit="'+c.id+'">Edit</button><button data-del="'+c.id+'">Delete</button></div></div>').join('')
:'<div class="empty"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"><path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5z"/></svg>No comments yet<br><span style="color:var(--faint)">Pause the video and leave your first note.</span></div>';}
function seek(t){if(!v)return;v.currentTime=t;v.pause();setAt();}
$('#list').onclick=async e=>{const b=e.target.closest('button');const card=e.target.closest('.c');try{
if(b&&b.dataset.done){const c=R.comments.find(x=>x.id===b.dataset.done);await post('comment-update',{id:c.id,patch:{done:!c.done}});}
else if(b&&b.dataset.edit){const c=R.comments.find(x=>x.id===b.dataset.edit);const n=prompt('Edit comment',c.text);if(n!==null)await post('comment-update',{id:c.id,patch:{text:n}});}
else if(b&&b.dataset.del){if(confirm('Delete this comment?'))await post('comment-delete',{id:b.dataset.del});}
else if(card&&!e.target.closest('a,video'))seek(Number(card.dataset.t));}catch(err){alert('Could not save: '+err.message);}};
// player controls
const playIco=$('#playIco');const setIco=()=>{playIco.innerHTML=v&&!v.paused?'<rect x="3.5" y="2.5" width="3.2" height="11" rx="1"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="1"/>':'<path d="M4 2.5v11l9-5.5z"/>';};
function tick(){if(!v)return;const d=v.duration||1,p=v.currentTime/d*100;$('#played').style.width=p+'%';$('#head').style.left=p+'%';$('#tc').textContent=tc(v.currentTime);if(!busy())setAt();
document.querySelectorAll('.c').forEach(el=>el.classList.toggle('now',Math.abs(Number(el.dataset.t)-v.currentTime)<0.6));}
if(v){v.addEventListener('timeupdate',tick);v.addEventListener('seeked',tick);v.addEventListener('loadedmetadata',()=>{render();tick();});v.addEventListener('play',()=>{setIco();if($('#stage').classList.contains('drawing'))stopDraw(true);});v.addEventListener('pause',setIco);
v.addEventListener('click',()=>{if(!$('#stage').classList.contains('drawing'))v.paused?v.play():v.pause();});}
$('#play').onclick=()=>v&&(v.paused?v.play():v.pause());
const rates=[0.5,1,1.5,2];$('#rate').onclick=()=>{if(!v)return;const i=(rates.indexOf(v.playbackRate)+1)%rates.length;v.playbackRate=rates[i];$('#rate').textContent=rates[i].toFixed(1)+'x';};
$('#mute').onclick=()=>{if(!v)return;v.muted=!v.muted;$('#mute').textContent=v.muted?'🔇':'🔊';};
$('#fs').onclick=()=>{const s=$('#stage');document.fullscreenElement?document.exitFullscreen():s.requestFullscreen&&s.requestFullscreen();};
let drag=false;const scrub=e=>{if(!v||!v.duration)return;const r=$('#track').getBoundingClientRect();v.currentTime=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width))*v.duration;setAt();};
$('#track').onpointerdown=e=>{if(e.target.classList.contains('pin'))return;drag=true;v&&v.pause();scrub(e);$('#track').setPointerCapture(e.pointerId);};$('#track').onpointermove=e=>{if(drag)scrub(e);};$('#track').onpointerup=()=>{drag=false;};
addEventListener('keydown',e=>{if(e.target.matches('textarea,input'))return;if(!v)return;if(e.code==='Space'){e.preventDefault();v.paused?v.play():v.pause();}
else if(e.key==='ArrowLeft'){v.currentTime=Math.max(0,v.currentTime-(e.shiftKey?1:1/FPS));}else if(e.key==='ArrowRight'){v.currentTime=Math.min(v.duration,v.currentTime+(e.shiftKey?1:1/FPS));}});
$('#text').addEventListener('focus',()=>{if(v&&!v.paused)v.pause();if(!$('#stage').classList.contains('drawing'))setAt();});
$('#text').addEventListener('input',()=>{const t=$('#text');t.style.height='auto';t.style.height=Math.min(160,t.scrollHeight)+'px';});
$('#text').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#post').click();}});
// drawing straight on the player; strokes are 0-1 positions inside the picture
const ov=$('#ov'),ctx=ov?ov.getContext('2d'):null;let strokes=[],cur=null;
function picRect(){const w=ov.clientWidth,h=ov.clientHeight,va=(v.videoWidth||16)/(v.videoHeight||9);let pw=w,ph=w/va;if(ph>h){ph=h;pw=h*va;}return{x:(w-pw)/2,y:(h-ph)/2,w:pw,h:ph};}
function paint(g,r,lw){g.lineCap='round';g.lineJoin='round';g.lineWidth=lw;for(const s of strokes){g.strokeStyle=s.c;g.beginPath();s.p.forEach((q,i)=>{const x=r.x+q[0]*r.w,y=r.y+q[1]*r.h;i?g.lineTo(x,y):g.moveTo(x,y);});g.stroke();}}
function redraw(){if(!ov)return;ov.width=ov.clientWidth*devicePixelRatio;ov.height=ov.clientHeight*devicePixelRatio;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);ctx.clearRect(0,0,ov.width,ov.height);paint(ctx,picRect(),4);}
function startDraw(){if(!v)return;v.pause();setAt();$('#stage').classList.add('drawing');$('#tools').classList.add('on');$('#drawBtn').style.color='var(--danger)';redraw();}
function stopDraw(clear){$('#stage').classList.remove('drawing');$('#tools').classList.remove('on');$('#drawBtn').style.color='';if(clear)strokes=[];redraw();}
$('#drawBtn').onclick=()=>$('#stage').classList.contains('drawing')?stopDraw(false):startDraw();$('#drawDone').onclick=()=>{stopDraw(false);$('#text').focus();};
if(ov){const pos=e=>{const b=ov.getBoundingClientRect(),r=picRect();return[(e.clientX-b.left-r.x)/r.w,(e.clientY-b.top-r.y)/r.h];};
ov.onpointerdown=e=>{cur={c:$('#pen').value,p:[pos(e)]};strokes.push(cur);ov.setPointerCapture(e.pointerId);};
ov.onpointermove=e=>{if(cur){cur.p.push(pos(e));redraw();}};ov.onpointerup=()=>{cur=null;};addEventListener('resize',redraw);}
$('#undo').onclick=()=>{strokes.pop();redraw();};$('#clear').onclick=()=>{strokes=[];redraw();};
function snapshot(){const w=v.videoWidth||1920,h=v.videoHeight||1080,c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle='#222';g.fillRect(0,0,w,h);try{g.drawImage(v,0,0,w,h);}catch(e){}paint(g,{x:0,y:0,w:w,h:h},Math.max(4,w/150));return c.toDataURL('image/png');}
// attachments
let files=[];const readUrl=f=>new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(f);});
function chips(){$('#chips').innerHTML=files.map((f,i)=>'<span class="fchip">📎 '+esc(f.name)+'<b data-rm="'+i+'">×</b></span>').join('');}
$('#chips').onclick=e=>{if(e.target.dataset.rm!==undefined){files.splice(Number(e.target.dataset.rm),1);chips();}};
$('#attachBtn').onclick=()=>{if(v){v.pause();if(!$('#text').value)setAt();}const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='image/*,video/*,audio/*,.pdf,.txt,.md,.ppt,.pptx,.key,.doc,.docx,.xls,.xlsx,.csv,.zip,.psd,.ai,.aep,.prproj,.srt,.json';
i.onchange=()=>{for(const f of i.files){if(f.size>80*1024*1024){alert(f.name+' is over 80 MB.');continue;}files.push(f);}chips();};i.click();};
$('#post').onclick=async()=>{const text=$('#text').value.trim();const drew=strokes.length>0;if(!text&&!drew&&!files.length){$('#msg').textContent='Write, attach or draw first.';return;}
$('#post').disabled=true;$('#msg').textContent=files.length?'Uploading…':'';
try{const attachments=[];for(const f of files)attachments.push({name:f.name,dataUrl:await readUrl(f)});
await post('comment',{time:pinTime,text,dataUrl:drew?snapshot():undefined,attachments});$('#text').value='';$('#text').style.height='';files=[];chips();stopDraw(true);$('#msg').textContent='Posted at '+tc(pinTime);}catch(e){alert('Could not save: '+e.message);}$('#post').disabled=false;};
${FINISH_JS}
render();
</script></body></html>`;
}

// ---------- server ----------

const TYPES = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv', '.zip': 'application/zip', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8' };

function sendFile(req, res, file) {
  const size = statSync(file).size;
  const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(end, size - 1);
    if (start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
  createReadStream(file).pipe(res);
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((ok, fail) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { fail(new Error('Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { ok(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { fail(e); } });
  });
}

const ATTACH_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'pdf', 'txt', 'md',
  'ppt', 'pptx', 'key', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'zip', 'psd', 'ai', 'aep', 'prproj', 'srt', 'json']);
const ATTACH = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'application/pdf': 'pdf', 'text/plain': 'txt' };

/** Save a file attached to a timeline comment into review/attachments. */
function saveAttachment(p, stemId, dataUrl, name = '') {
  const m = String(dataUrl).match(/^data:([\w.+-]*\/?[\w.+-]*);base64,(.*)$/);
  // Trust the file name's extension when it is on the list (browsers often send no type for Office files).
  const byName = extname(name).slice(1).toLowerCase();
  const ext = m && (ATTACH_EXT.has(byName) ? byName : ATTACH[m[1]]);
  if (!ext) throw new Error(`Can't attach ${name || 'this file'}. Allowed: images, video, audio, PDF, PowerPoint, Word, Excel, CSV, text and zip files.`);
  const dir = join(p.reviewDir, 'attachments');
  mkdirSync(dir, { recursive: true });
  const safe = basename(name, extname(name)).replace(/[^a-z0-9-]+/gi, '-').slice(0, 40);
  const file = join(dir, `${stemId}-r${p.review.round}-${Date.now()}${safe ? '-' + safe : ''}.${ext}`);
  writeFileSync(file, Buffer.from(m[2], 'base64'));
  return relative(p.dir, file).split(sep).join('/');
}

function saveImage(p, beatId, kind, dataUrl, name = '') {
  const m = String(dataUrl).match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
  if (!m) throw new Error('Only images can be saved');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const dir = join(p.reviewDir, kind);
  mkdirSync(dir, { recursive: true });
  const stem = `${beatId}-r${p.review.round}-${Date.now()}`;
  const safe = name ? '-' + basename(name, extname(name)).replace(/[^a-z0-9-]+/gi, '-').slice(0, 40) : '';
  const file = join(dir, `${stem}${safe}.${ext}`);
  writeFileSync(file, Buffer.from(m[2], 'base64'));
  return relative(p.dir, file).split(sep).join('/');
}

export function startServer(projects, port = 4848) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/') {
        if (projects.length === 1) { res.writeHead(302, { location: '/p/0/' }); return res.end(); }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(indexHtml(projects));
      }
      const m = url.pathname.match(/^\/p\/(\d+)\/(.*)$/);
      const p = m && projects[Number(m[1])];
      if (!p) { res.writeHead(404); return res.end('Not found'); }
      const base = `/p/${m[1]}/`;
      const rest = decodeURIComponent(m[2]);
      if (req.method === 'GET' && rest === '') {
        p.precheck = readJson(join(p.reviewDir, 'precheck.json'))?.beats ?? {};
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(p.mode === 'timeline' ? timelineHtml(p, base, { i: Number(m[1]), n: projects.length }) : boardHtml(p, base));
      }
      if (req.method === 'GET' && rest === 'thumb.jpg') {
        const thumb = join(p.reviewDir, 'thumb.jpg');
        if (p.video && (!existsSync(thumb) || statSync(thumb).mtimeMs < statSync(p.video).mtimeMs)) {
          mkdirSync(p.reviewDir, { recursive: true });
          const at = Math.min(3, (p.duration || 2) / 3).toFixed(2);
          spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', at, '-i', p.video, '-frames:v', '1', '-vf', 'scale=640:640:force_original_aspect_ratio=decrease', thumb]);
        }
        if (!existsSync(thumb)) { res.writeHead(404); return res.end('No thumbnail'); }
        return sendFile(req, res, thumb);
      }
      if (req.method === 'GET' && rest.startsWith('media/')) {
        const file = resolve(p.dir, rest.slice(6));
        const inside = file.startsWith(p.dir + sep) || (p.video && file === resolve(p.video));
        if (!inside || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
        return sendFile(req, res, file);
      }
      if (req.method === 'GET' && rest === 'amend-status') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify(amendStatus(p)));
      }
      if (req.method === 'POST' && rest === 'amend-stop') {
        if (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin)) { res.writeHead(403); return res.end('Forbidden'); }
        const j = amendJobs.get(p.dir);
        if (j?.child) { j.state = 'stopped'; j.result = 'Stopped. Your notes are still saved.'; j.child.kill(); }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(amendStatus(p)));
      }
      if (req.method === 'POST' && rest === 'finish') {
        if (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin)) { res.writeHead(403); return res.end('Forbidden'); }
        const body = await readBody(req);
        const at = new Date().toISOString();
        let message;
        if (body.kind === 'approve') {
          p.review.amend = { state: 'approved', at };
          message = 'Approved. Nothing will change.';
        } else {
          const open = (p.review.comments ?? []).filter((c) => !c.done).length + p.review.beats.filter((b) => b.status === 'change').length;
          if (!open) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'There are no open notes to amend.' })); }
          if (process.env.REVIEW_AMEND === 'off') {
            message = `Saved. Tell Claude: I left review notes on ${p.review.project}, let's amend.`;
          } else {
            try { runAmend(p, process.cwd()); } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: e.message })); }
            p.review.amend = { state: 'sent', at };
            message = `Sent ${open} notes. Claude is working on them.`;
          }
        }
        p.review.updatedAt = at;
        save(p);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ message }));
      }
      if (req.method === 'POST' && ['comment', 'comment-update', 'comment-delete'].includes(rest)) {
        if (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin)) { res.writeHead(403); return res.end('Forbidden'); }
        const body = await readBody(req, rest === 'comment' ? 120 * 1024 * 1024 : undefined);
        if (rest === 'comment') {
          const stem = `t${Math.round(Number(body.time) * 10)}`;
          const attachments = (Array.isArray(body.attachments) ? body.attachments : []).slice(0, 10)
            .map((a) => ({ file: saveAttachment(p, stem, a.dataUrl, a.name), name: String(a.name ?? '').slice(0, 120) }));
          const drawing = body.dataUrl ? saveImage(p, `t${Math.round(Number(body.time) * 10)}`, 'drawings', body.dataUrl) : null;
          addComment(p.review, { time: body.time, text: body.text, drawing, attachments });
        } else if (rest === 'comment-update') updateComment(p.review, body.id, body.patch ?? {});
        else deleteComment(p.review, body.id);
        save(p);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ comments: p.review.comments }));
      }
      if (req.method === 'POST' && ['save', 'drawing', 'upload'].includes(rest)) {
        if (req.headers.origin && !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(req.headers.origin)) { res.writeHead(403); return res.end('Forbidden'); }
        const body = await readBody(req);
        let beat;
        if (rest === 'save') beat = applyUpdate(p.review, body.beat, body.patch ?? {});
        else {
          beat = p.review.beats.find((b) => b.id === body.beat);
          if (!beat) throw new Error(`Unknown beat ${body.beat}`);
          const file = saveImage(p, beat.id, rest === 'drawing' ? 'drawings' : 'uploads', body.dataUrl, body.name);
          if (rest === 'drawing') { beat.drawings.push({ file, note: String(body.note ?? '').slice(0, 1000) }); beat.status = 'change'; }
          else beat.uploads.push({ file });
          p.review.updatedAt = new Date().toISOString();
        }
        save(p);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ beat }));
      }
      res.writeHead(404); res.end('Not found');
    } catch (e) {
      res.writeHead(400, { 'content-type': 'text/plain' }); res.end(String(e.message ?? e));
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(server));
  });
}

/** The message the amend session starts with. Plain words only, so it survives the shell. */
export function amendPrompt(p, kitRoot) {
  const rel = relative(kitRoot, p.dir).split(sep).join('/');
  return `I left review notes on ${rel}. Run npm run review -- ${rel} --notes to read them. ` +
    `If ${rel}/AMEND.md exists, follow it for how this project is built. ` +
    `Fix only what the notes flag, render the next numbered draft without overwriting earlier drafts, ` +
    `copy it into ${rel}/renders, then run npm run review -- ${rel} --mark-revised with the ids you fixed ` +
    `and add any lasting lesson to the client rules.`;
}

/** Tools the background amend may use without asking. A project can add more in <project>/amend.json. */
const AMEND_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npm run review:*)', 'Bash(npm run:*)', 'Bash(node:*)', 'Bash(npx hyperframes:*)',
  'Bash(python:*)', 'Bash(ffmpeg:*)', 'Bash(ffprobe:*)', 'Bash(cp:*)', 'Bash(mkdir:*)', 'Bash(ls:*)'];

/** Finds the Claude Code binary so it can run without a shell. */
function claudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  if (process.platform === 'win32') {
    const r = spawnSync('where', ['claude.cmd'], { encoding: 'utf8' });
    const cmd = r.stdout?.split(/\r?\n/).find(Boolean);
    const exe = cmd && join(cmd, '..', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (exe && existsSync(exe)) return exe;
  }
  return 'claude';
}

/** One background amend per project: Claude runs headless, the board shows its progress. */
const amendJobs = new Map();

export function amendSummary(event) {
  if (event?.type === 'assistant') {
    const out = [];
    for (const c of event.message?.content ?? []) {
      if (c.type === 'text' && c.text?.trim()) out.push(c.text.trim().split('\n')[0].slice(0, 200));
      if (c.type === 'tool_use') {
        const i = c.input ?? {};
        const what = i.description || i.command || i.file_path || i.pattern || '';
        out.push(`${c.name}${what ? ': ' + String(what).replace(/\s+/g, ' ').slice(0, 140) : ''}`);
      }
    }
    return out;
  }
  return [];
}

function runAmend(p, kitRoot) {
  const job = amendJobs.get(p.dir);
  if (job?.state === 'running') return job;
  const cfgPath = join(p.dir, 'amend.json');
  const cfg = readJson(cfgPath) ?? {};
  if (existsSync(cfgPath) && !readJson(cfgPath)) throw new Error('amend.json is not valid JSON (use forward slashes or double backslashes in paths)');
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
    '--allowedTools', ...AMEND_TOOLS, ...(cfg.allowedTools ?? [])];
  for (const d of cfg.addDirs ?? []) args.push('--add-dir', d);
  // Started from inside another Claude session, the child must not inherit that session's identity.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_(BASE_URL|AUTH))/.test(k) && k !== 'CLAUDECODE'));
  mkdirSync(p.reviewDir, { recursive: true });
  const logFile = join(p.reviewDir, 'amend.log');
  writeFileSync(logFile, '');
  const next = { state: 'running', startedAt: new Date().toISOString(), steps: [], result: '' };
  amendJobs.set(p.dir, next);
  let child;
  try {
    child = spawn(claudeBin(), args, { cwd: kitRoot, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    Object.assign(next, { state: 'failed', result: `Could not start Claude: ${e.message}` });
    return next;
  }
  next.child = child;
  child.stdin.end(amendPrompt(p, kitRoot));
  let buf = '';
  child.stdout.on('data', (d) => {
    writeFileSync(logFile, d, { flag: 'a' });
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      next.steps.push(...amendSummary(ev));
      if (next.steps.length > 60) next.steps.splice(0, next.steps.length - 60);
      if (ev.type === 'result') { next.result = String(ev.result ?? ''); next.isError = Boolean(ev.is_error); }
    }
  });
  child.stderr.on('data', (d) => writeFileSync(logFile, d, { flag: 'a' }));
  child.on('error', (e) => Object.assign(next, { state: 'failed', result: `Could not start Claude: ${e.message}` }));
  child.on('close', (code) => {
    delete next.child;
    next.endedAt = new Date().toISOString();
    if (next.state === 'stopped') return;
    const auth = /authenticat|log ?in|OAuth/i.test(next.result);
    next.state = code === 0 && !next.isError ? 'done' : 'failed';
    if (auth) next.result = 'Claude Code needs you to sign in once on this PC: open a terminal, run "claude", type /login, then press Send again.';
    // Pick up the new draft and the updated review state Claude wrote.
    try {
      const fresh = loadProject(p.dir, { mode: p.mode });
      Object.assign(p, { video: fresh.video, duration: fresh.duration, review: fresh.review, source: fresh.source });
    } catch {}
    p.review.amend = { state: next.state === 'done' ? 'amended' : 'failed', at: next.endedAt };
    save(p);
  });
  return next;
}

function amendStatus(p) {
  const j = amendJobs.get(p.dir);
  if (!j) return { state: 'idle' };
  const { child, ...rest } = j;
  return { ...rest, video: p.review.video, round: p.review.round };
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch {}
}

// ---------- CLI ----------

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opts = { dirs: [], port: 4848, open: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--video') opts.video = args[++i];
    else if (a === '--every') opts.every = args[++i];
    else if (a === '--port') opts.port = Number(args[++i]);
    else if (a === '--no-open') opts.open = false;
    else if (a === '--beats') opts.mode = 'beats';
    else if (a === '--timeline') opts.mode = 'timeline';
    else if (a === '--notes') opts.notes = true;
    else if (a === '--mark-revised') opts.revised = args[++i]?.split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--all') opts.all = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else opts.dirs.push(a);
  }
  if (opts.all) {
    const root = resolve('video-projects');
    for (const d of existsSync(root) ? readdirSync(root) : []) {
      const full = join(root, d);
      if (!d.startsWith('_') && statSync(full).isDirectory() && findVideo(full)) opts.dirs.push(full);
    }
  }
  if (opts.help || !opts.dirs.length) {
    console.log('Usage: npm run review -- video-projects/<slug> [more...] | --all  [--timeline | --beats] [--notes] [--mark-revised b01,c02] [--video file] [--every 3] [--port 4848] [--no-open]');
    process.exit(opts.help ? 0 : 1);
  }
  if (opts.video && opts.dirs.length > 1) { console.error('--video works with one project at a time.'); process.exit(1); }
  // One video gets Frame.io-style timestamp comments; a batch gets beat cards.
  if (!opts.mode) opts.mode = opts.dirs.length === 1 && !opts.every ? 'timeline' : 'beats';
  let projects;
  try { projects = opts.dirs.map((d) => loadProject(d, opts)); }
  catch (e) { console.error(e.message); process.exit(1); }

  if (opts.revised) {
    if (projects.length !== 1) { console.error('--mark-revised works with one project at a time.'); process.exit(1); }
    try { markRevised(projects[0].review, opts.revised); } catch (e) { console.error(e.message); process.exit(1); }
    save(projects[0]);
    console.log(`Sent ${opts.revised.join(', ')} back for review (round ${projects[0].review.round}).`);
  } else if (opts.notes) {
    console.log(projects.map((p) => notesText(p.review)).join('\n\n'));
  } else {
    for (const p of projects) { save(p); if (!p.video) console.warn(`No rendered video in ${p.dir}. Render a draft or pass --video.`); }
    startServer(projects, opts.port).then(() => {
      const url = `http://127.0.0.1:${opts.port}/`;
      console.log(`Review board running at ${url}`);
      for (const p of projects) {
        const s = summarize(p.review);
        const what = p.mode === 'timeline' ? `timestamp comments (${p.review.comments.length} so far)` : `${s.total} beats (${p.source})`;
        console.log(`- ${p.review.project}: ${what}, notes save to ${relative(process.cwd(), p.reviewPath)}`);
      }
      console.log('Leave this window open while you review. Press Ctrl+C when you are done.');
      if (opts.open) openBrowser(url);
    }, (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${opts.port} is busy. Close the other board or add --port 4849.` : e.message); process.exit(1); });
  }
}
