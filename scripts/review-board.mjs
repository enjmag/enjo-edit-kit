#!/usr/bin/env node
// Review board: one card per beat of a rendered draft, with Approve / Change,
// a note box, Draw-on-frame, reference upload, and "New idea". Notes save into
// <project>/review/REVIEW.json so Claude can fix only the beats you flagged.
//
// Usage:
//   npm run review -- video-projects/<slug> [more projects...]   open the board
//   npm run review -- --all                                       every project with a video
//   npm run review -- video-projects/<slug> --notes               print the to-do list
//   npm run review -- video-projects/<slug> --mark-revised b03,b05
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
  };
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
  const unknown = [...want].filter((id) => !review.beats.some((b) => b.id === id || b.key === id));
  if (unknown.length) throw new Error(`Unknown beats: ${unknown.join(', ')}`);
  for (const b of review.beats) {
    if (!want.has(b.id) && !want.has(b.key)) continue;
    b.history.push({ round: review.round, status: b.status, newIdea: b.newIdea, note: b.note, drawings: b.drawings, uploads: b.uploads, at: now });
    Object.assign(b, { status: 'waiting', newIdea: false, note: '', drawings: [], uploads: [], revisedInRound: review.round });
  }
  review.round += 1;
  review.updatedAt = now;
  return review;
}

export function notesText(review) {
  const s = summarize(review);
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
  if (!beats.length) {
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
  return { dir, video, source, review, reviewDir, reviewPath, precheck };
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
.history{color:var(--dim);font-size:13px}
dialog{background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:12px;max-width:95vw}dialog canvas{max-width:85vw;max-height:70vh;cursor:crosshair;border-radius:8px;display:block}
@media(max-width:860px){header{position:static}main{grid-template-columns:1fr}.player{position:static}.card{grid-template-columns:1fr}}
</style></head><body>
<header><h1>Review: ${esc(p.review.project)}</h1><div class="counts"><span class="a" id="nA"></span><span class="c" id="nC"></span><span class="w" id="nW"></span></div>
<div class="bar" id="bar"></div><button id="next">Next to review ↓</button><button id="copy">Copy message for Claude</button></header>
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
const v=$('video',el);if(v){v.addEventListener('timeupdate',()=>{if(v.currentTime>=b.end-0.03){v.currentTime=b.start;}});v.addEventListener('play',()=>{if(v.currentTime<b.start||v.currentTime>=b.end)v.currentTime=b.start;});}
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
$('#copy').onclick=()=>{navigator.clipboard?.writeText('I left review notes on '+R.project+', let\\'s amend.');$('#copy').textContent='Copied';};
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

function indexHtml(projects) {
  const rows = projects.map((p, i) => {
    const s = summarize(p.review);
    return `<li><a href="/p/${i}/">${esc(p.review.project)}</a> <span>${s.approved} approved · ${s.change} to change · ${s.waiting} waiting</span></li>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review boards</title>
<style>body{margin:0;padding:24px 16px;background:#101318;color:#e9edf2;font:16px/1.5 system-ui,Segoe UI,sans-serif}ul{list-style:none;padding:0;max-width:720px}li{background:#181c23;border:1px solid #2a303a;border-radius:10px;padding:12px 16px;margin-bottom:10px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}a{color:#9fb4ff;font-weight:600}span{color:#93a0b0}</style></head>
<body><h1>Review boards</h1><p>Open each video, approve or flag every beat, then tell Claude which videos you reviewed.</p><ul>${rows}</ul></body></html>`;
}

// ---------- server ----------

const TYPES = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.json': 'application/json' };

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
        return res.end(boardHtml(p, base));
      }
      if (req.method === 'GET' && rest.startsWith('media/')) {
        const file = resolve(p.dir, rest.slice(6));
        const inside = file.startsWith(p.dir + sep) || (p.video && file === resolve(p.video));
        if (!inside || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
        return sendFile(req, res, file);
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
    console.log('Usage: npm run review -- video-projects/<slug> [more...] | --all  [--notes] [--mark-revised b01,b02] [--video file] [--every 3] [--port 4848] [--no-open]');
    process.exit(opts.help ? 0 : 1);
  }
  if (opts.video && opts.dirs.length > 1) { console.error('--video works with one project at a time.'); process.exit(1); }
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
      for (const p of projects) { const s = summarize(p.review); console.log(`- ${p.review.project}: ${s.total} beats (${p.source}), notes save to ${relative(process.cwd(), p.reviewPath)}`); }
      console.log('Leave this window open while you review. Press Ctrl+C when you are done.');
      if (opts.open) openBrowser(url);
    }, (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${opts.port} is busy. Close the other board or add --port 4849.` : e.message); process.exit(1); });
  }
}
