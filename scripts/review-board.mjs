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
  return { dir, video, source, review, reviewDir, reviewPath, precheck, mode: opts.mode === 'timeline' ? 'timeline' : 'beats' };
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

/** Timeline view: one player, comments pinned to timestamps, drawing right on the frame (like Frame.io). */
export function timelineHtml(p, base) {
  const data = JSON.stringify({ review: p.review, base }).replace(/</g, '\\u003c');
  const videoUrl = p.review.video ? `${base}media/${p.review.video.split('/').map(encodeURIComponent).join('/')}` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Review: ${esc(p.review.project)}</title>
<style>
:root{--bg:#101318;--panel:#181c23;--line:#2a303a;--text:#e9edf2;--dim:#93a0b0;--ok:#3fbf6f;--acc:#f0a63a;--blue:#6f8cff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,Segoe UI,sans-serif}
header{border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}header h1{font-size:16px;margin:0}
.counts{color:var(--dim)}.counts b{color:var(--acc)}
button{font:inherit;color:var(--text);background:#232934;border:1px solid var(--line);border-radius:8px;padding:6px 12px;cursor:pointer}button:hover{border-color:#4a5568}
button.primary{background:var(--acc);color:#2b1a00;border-color:var(--acc);font-weight:600}button.on{background:#ff3b30;border-color:#ff3b30;color:#fff}
main{display:grid;grid-template-columns:1fr minmax(300px,400px);gap:18px;padding:16px;max-width:1700px;margin:auto}
.stage{position:relative}video{width:100%;max-height:68vh;background:#000;border-radius:10px;display:block}
#ov{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;border-radius:10px}.stage.drawing #ov{pointer-events:auto;cursor:crosshair;outline:3px solid #ff3b30}
.tools{display:none;gap:8px;align-items:center;margin-top:8px}.stage.drawing+.tools{display:flex}
.track{position:relative;height:26px;margin:10px 0 4px;background:#1d222b;border-radius:6px;cursor:pointer}
.track .played{position:absolute;left:0;top:0;bottom:0;background:#2c3646;border-radius:6px;pointer-events:none}
.track .pin{position:absolute;top:3px;width:12px;height:20px;margin-left:-6px;border-radius:4px;background:var(--acc);border:2px solid #101318}.track .pin.done{background:var(--ok);opacity:.6}
.composer{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px;margin-top:10px}
.at{font-weight:700;color:var(--acc);font-variant-numeric:tabular-nums}
textarea{width:100%;min-height:70px;background:#0f1216;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:8px;font:inherit;resize:vertical;margin:8px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.dim{color:var(--dim);font-size:13px}
aside h2{font-size:14px;margin:0 0 8px;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
.c{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--acc);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.c.done{border-left-color:var(--ok);opacity:.65}.c.now{outline:2px solid var(--blue)}
.c .t{font-weight:700;color:var(--acc);cursor:pointer;font-variant-numeric:tabular-nums}.c.done .t{color:var(--ok)}
.c p{margin:6px 0;white-space:pre-wrap}.c img{max-width:100%;border-radius:6px;border:1px solid var(--line);margin-top:4px}
.c .row button{padding:3px 10px;font-size:13px}.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.chip{background:#232934;border:1px solid var(--line);border-radius:14px;padding:2px 10px;font-size:13px}.chip b{cursor:pointer;margin-left:6px;color:var(--dim)}
.att{display:block;margin-top:4px;color:#9fb4ff;font-size:13px}.c video{max-width:100%;border-radius:6px;margin-top:4px}
@media(max-width:900px){main{grid-template-columns:1fr}}
</style></head><body>
<header><h1>Review: ${esc(p.review.project)}</h1><span class="counts" id="counts"></span><span style="flex:1"></span>
${finishButtons(p.review)}${base !== '/' ? '<a href="/" style="color:var(--dim)">all videos</a>' : ''}</header>
<main><section>
<div class="stage" id="stage">${videoUrl ? `<video id="v" src="${esc(videoUrl)}" controls playsinline preload="metadata"></video><canvas id="ov"></canvas>` : '<p>No rendered video found. Render a draft first.</p>'}</div>
<div class="tools"><b>Drawing</b><span class="dim">Draw on the frame, then write your comment and post.</span><span style="flex:1"></span>Colour <input type="color" id="pen" value="#ff3b30"><button id="undo">Undo</button><button id="clear">Clear</button></div>
<div class="track" id="track"><div class="played" id="played"></div></div>
<div class="composer"><div class="row"><span>Comment at <span class="at" id="at">0:00.0</span></span><span class="dim">The video pauses while you type or draw.</span></div>
<textarea id="text" placeholder="What should change here? (Ctrl+Enter to post)"></textarea>
<div class="row"><button class="primary" id="post">Post comment</button><button id="attachBtn">📎 Attach</button><button id="drawBtn">✎ Draw on frame</button><span class="dim" id="msg"></span></div>
<div class="chips" id="chips"></div></div>
<p class="dim">Pause anywhere, write what to change, and post. Click a comment to jump back to it. When you're done, press <b>Send notes for amend</b> and Claude starts fixing them on this PC, or <b>Approve video</b> if nothing needs to change.</p>
</section>
<aside><h2>Comments</h2><div id="list"></div></aside></main>
<script>
const S=${data};const R=S.review;const base=S.base;
const $=q=>document.querySelector(q);const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=t=>{t=Math.max(0,t||0);const m=Math.floor(t/60);return m+':'+(t-m*60).toFixed(1).padStart(4,'0');};
const v=$('#v');let pinTime=0;
async function post(path,body){const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});if(!r.ok)throw new Error(await r.text());const j=await r.json();R.comments=j.comments;render();return j;}
const busy=()=>document.activeElement===$('#text')||$('#stage').classList.contains('drawing');
function setAt(){pinTime=v?v.currentTime:0;$('#at').textContent=fmt(pinTime);}
function render(){const open=R.comments.filter(c=>!c.done).length;$('#counts').innerHTML='<b>'+open+'</b> open · '+(R.comments.length-open)+' resolved · round '+R.round;
const d=v&&v.duration||0;$('#track').querySelectorAll('.pin').forEach(e=>e.remove());
if(d)R.comments.forEach(c=>{const e=document.createElement('div');e.className='pin'+(c.done?' done':'');e.style.left=(c.time/d*100)+'%';e.title=fmt(c.time)+' '+c.text;e.onclick=ev=>{ev.stopPropagation();seek(c.time);};$('#track').appendChild(e);});
$('#list').innerHTML=R.comments.length?R.comments.map(c=>'<div class="c'+(c.done?' done':'')+'" id="'+c.id+'"><div class="row"><span class="t" data-t="'+c.time+'">'+fmt(c.time)+'</span><span class="dim">'+c.id+(c.round>1?' · round '+c.round:'')+'</span></div>'+
(c.text?'<p>'+esc(c.text)+'</p>':'')+(c.attachments||[]).map(a=>{const u=base+'media/'+a.file;return /\\.(png|jpe?g|gif|webp)$/i.test(a.file)?'<a href="'+u+'" target="_blank"><img src="'+u+'" alt=""></a>':/\\.(mp4|webm|mov)$/i.test(a.file)?'<video src="'+u+'" controls preload="metadata"></video>':'<a class="att" href="'+u+'" target="_blank">📎 '+esc(a.name||a.file)+'</a>';}).join('')+(c.drawing?'<a href="'+base+'media/'+c.drawing+'" target="_blank"><img src="'+base+'media/'+c.drawing+'" alt="drawing"></a>':'')+
'<div class="row"><button data-done="'+c.id+'">'+(c.done?'Reopen':'Resolve')+'</button><button data-edit="'+c.id+'">Edit</button><button data-del="'+c.id+'">Delete</button></div></div>').join(''):'<p class="dim">No comments yet. Pause the video where something should change and write it below the player.</p>';}
function seek(t){if(!v)return;v.currentTime=t;v.pause();setAt();}
$('#list').onclick=async e=>{const t=e.target;try{
if(t.dataset.t)seek(Number(t.dataset.t));
else if(t.dataset.done){const c=R.comments.find(x=>x.id===t.dataset.done);await post('comment-update',{id:c.id,patch:{done:!c.done}});}
else if(t.dataset.edit){const c=R.comments.find(x=>x.id===t.dataset.edit);const n=prompt('Edit comment',c.text);if(n!==null)await post('comment-update',{id:c.id,patch:{text:n}});}
else if(t.dataset.del){if(confirm('Delete this comment?'))await post('comment-delete',{id:t.dataset.del});}}catch(err){alert('Could not save: '+err.message);}};
if(v){v.addEventListener('timeupdate',()=>{if(!busy())setAt();const d=v.duration||1;$('#played').style.width=(v.currentTime/d*100)+'%';
document.querySelectorAll('.c').forEach(el=>{const c=R.comments.find(x=>x.id===el.id);el.classList.toggle('now',!!c&&Math.abs(c.time-v.currentTime)<0.6);});});
v.addEventListener('loadedmetadata',render);v.addEventListener('seeked',()=>{if(!busy())setAt();});v.addEventListener('play',()=>{if($('#stage').classList.contains('drawing'))stopDraw(true);});}
$('#track').onclick=e=>{if(!v||!v.duration)return;const r=$('#track').getBoundingClientRect();seek((e.clientX-r.left)/r.width*v.duration);};
$('#text').addEventListener('focus',()=>{if(v&&!v.paused){v.pause();}if(!$('#stage').classList.contains('drawing'))setAt();});
$('#text').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('#post').click();}});
// drawing straight on the player; strokes are stored as 0-1 positions inside the picture
const ov=$('#ov'),ctx=ov?ov.getContext('2d'):null;let strokes=[],cur=null;
function picRect(){const w=ov.clientWidth,h=ov.clientHeight,va=(v.videoWidth||16)/(v.videoHeight||9);let pw=w,ph=w/va;if(ph>h){ph=h;pw=h*va;}return{x:(w-pw)/2,y:(h-ph)/2,w:pw,h:ph};}
function paint(g,r,lw){g.lineCap='round';g.lineJoin='round';g.lineWidth=lw;for(const s of strokes){g.strokeStyle=s.c;g.beginPath();s.p.forEach((q,i)=>{const x=r.x+q[0]*r.w,y=r.y+q[1]*r.h;i?g.lineTo(x,y):g.moveTo(x,y);});g.stroke();}}
function redraw(){if(!ov)return;ov.width=ov.clientWidth*devicePixelRatio;ov.height=ov.clientHeight*devicePixelRatio;ctx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);ctx.clearRect(0,0,ov.width,ov.height);paint(ctx,picRect(),4);}
function startDraw(){if(!v)return;v.pause();setAt();v.controls=false;$('#stage').classList.add('drawing');$('#drawBtn').classList.add('on');$('#drawBtn').textContent='Stop drawing';redraw();}
function stopDraw(clear){$('#stage').classList.remove('drawing');$('#drawBtn').classList.remove('on');$('#drawBtn').textContent='✎ Draw on frame';v.controls=true;if(clear){strokes=[];}redraw();}
$('#drawBtn').onclick=()=>$('#stage').classList.contains('drawing')?stopDraw(false):startDraw();
if(ov){const pos=e=>{const b=ov.getBoundingClientRect(),r=picRect();return[(e.clientX-b.left-r.x)/r.w,(e.clientY-b.top-r.y)/r.h];};
ov.onpointerdown=e=>{cur={c:$('#pen').value,p:[pos(e)]};strokes.push(cur);ov.setPointerCapture(e.pointerId);};
ov.onpointermove=e=>{if(cur){cur.p.push(pos(e));redraw();}};ov.onpointerup=()=>{cur=null;};addEventListener('resize',redraw);}
$('#undo').onclick=()=>{strokes.pop();redraw();};$('#clear').onclick=()=>{strokes=[];redraw();};
function snapshot(){const w=v.videoWidth||1920,h=v.videoHeight||1080,c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.fillStyle='#222';g.fillRect(0,0,w,h);try{g.drawImage(v,0,0,w,h);}catch(e){}paint(g,{x:0,y:0,w:w,h:h},Math.max(4,w/150));return c.toDataURL('image/png');}
let files=[];const readUrl=f=>new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(f);});
function chips(){$('#chips').innerHTML=files.map((f,i)=>'<span class="chip">📎 '+esc(f.name)+'<b data-rm="'+i+'">×</b></span>').join('');}
$('#chips').onclick=e=>{if(e.target.dataset.rm!==undefined){files.splice(Number(e.target.dataset.rm),1);chips();}};
$('#attachBtn').onclick=()=>{if(v){v.pause();if(!$('#text').value)setAt();}const i=document.createElement('input');i.type='file';i.multiple=true;i.accept='image/*,video/*,audio/*,.pdf,.txt,.md,.ppt,.pptx,.key,.doc,.docx,.xls,.xlsx,.csv,.zip,.psd,.ai,.aep,.prproj,.srt,.json';
i.onchange=()=>{for(const f of i.files){if(f.size>80*1024*1024){alert(f.name+' is over 80 MB.');continue;}files.push(f);}chips();};i.click();};
$('#post').onclick=async()=>{const text=$('#text').value.trim();const drew=strokes.length>0;if(!text&&!drew&&!files.length){$('#msg').textContent='Write something, attach a file, or draw first.';return;}
$('#post').disabled=true;$('#msg').textContent=files.length?'Uploading…':'';
try{const attachments=[];for(const f of files)attachments.push({name:f.name,dataUrl:await readUrl(f)});
await post('comment',{time:pinTime,text,dataUrl:drew?snapshot():undefined,attachments});$('#text').value='';files=[];chips();stopDraw(true);$('#msg').textContent='Posted at '+fmt(pinTime);}catch(e){alert('Could not save: '+e.message);}$('#post').disabled=false;};
${FINISH_JS}
render();
</script></body></html>`;
}

function indexHtml(projects) {
  const rows = projects.map((p, i) => {
    const s = summarize(p.review);
    const open = (p.review.comments ?? []).filter((c) => !c.done).length;
    const info = p.mode === 'timeline' ? `${open} open comments` : `${s.approved} approved · ${s.change} to change · ${s.waiting} waiting`;
    return `<li><a href="/p/${i}/">${esc(p.review.project)}</a> <span>${info}</span></li>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review boards</title>
<style>body{margin:0;padding:24px 16px;background:#101318;color:#e9edf2;font:16px/1.5 system-ui,Segoe UI,sans-serif}ul{list-style:none;padding:0;max-width:720px}li{background:#181c23;border:1px solid #2a303a;border-radius:10px;padding:12px 16px;margin-bottom:10px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}a{color:#9fb4ff;font-weight:600}span{color:#93a0b0}</style></head>
<body><h1>Review boards</h1><p>Open each video, leave your notes, then tell Claude which videos you reviewed.</p><ul>${rows}</ul></body></html>`;
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
        return res.end(p.mode === 'timeline' ? timelineHtml(p, base) : boardHtml(p, base));
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
      Object.assign(p, { video: fresh.video, review: fresh.review, source: fresh.source });
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
