#!/usr/bin/env node
// Mix a voice track with a music bed and timed sound effects, then master it.
// Usage: node scripts/mix-bed.mjs <project-dir> --voice assets/silenced.mp4 --duration 82.33 --out renders/mix.wav
// Reads <project-dir>/sfx.json: { music: {file, start_in_track, voice_gap_db, fade_in, fade_out}, events: [{t, f, g}] }
// SFX files are looked up as <project-dir>/assets/sfx/<f>.wav.
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args[0] || '.');
const opt = (k, d) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : d; };
const voice = join(dir, opt('--voice', 'assets/silenced.mp4'));
const dur = Number(opt('--duration'));
const out = join(dir, opt('--out', 'renders/mix.wav'));
const voiceLufs = Number(opt('--voice-lufs', '-14'));
const masterLufs = Number(opt('--master-lufs', '-14'));
if (!dur) throw new Error('--duration <seconds> is required');
// Strip a UTF-8 byte-order mark (Windows PowerShell adds one) before parsing.
const cfg = JSON.parse(readFileSync(join(dir, 'sfx.json'), 'utf8').replace(/^﻿/, ''));
const tmp = join(dir, 'renders', 'mix-tmp'); mkdirSync(tmp, { recursive: true });

function ff(a) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || '').slice(-800));
}

// 1. Voice normalised to the target loudness.
const v = join(tmp, 'voice.wav');
ff(['-i', voice, '-vn', '-af', `loudnorm=I=${voiceLufs}:TP=-2:LRA=11`, '-ar', '48000', '-ac', '2', '-t', String(dur), v]);

// 2. Music bed: a window of the track, set a fixed gap under the voice, faded at both ends.
const m = cfg.music; const mw = join(tmp, 'music.wav');
const fo = m.fade_out ?? 1.4; const fi = m.fade_in ?? 1.0;
ff(['-ss', String(m.start_in_track ?? 0), '-t', String(dur), '-i', join(dir, m.file), '-af',
  `loudnorm=I=${voiceLufs - (m.voice_gap_db ?? 17)}:TP=-6:LRA=11,afade=t=in:d=${fi},afade=t=out:st=${(dur - fo).toFixed(3)}:d=${fo}`,
  '-ar', '48000', '-ac', '2', mw]);

// 2b. Duck the bed under speech (sidechain keyed on the voice) so it only rises in the gaps.
let bed = mw;
if (m.duck !== false) {
  bed = join(tmp, 'music-ducked.wav');
  ff(['-i', mw, '-i', v, '-filter_complex',
    `[0:a][1:a]sidechaincompress=threshold=${m.duck_threshold ?? 0.02}:ratio=${m.duck_ratio ?? 4}:attack=${m.duck_attack_ms ?? 30}:release=${m.duck_release_ms ?? 350}[d]`,
    '-map', '[d]', '-ar', '48000', '-ac', '2', bed]);
}

// 3. Everything together, then master.
const inputs = ['-i', v, '-i', bed];
const chains = [];
cfg.events.forEach((e, i) => {
  inputs.push('-i', join(dir, 'assets', 'sfx', `${e.f}.wav`));
  const ms = Math.max(0, Math.round(e.t * 1000));
  chains.push(`[${i + 2}:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=${e.g ?? -6}dB,adelay=${ms}|${ms}[s${i}]`);
});
const labels = ['[0:a]', '[1:a]', ...cfg.events.map((_, i) => `[s${i}]`)].join('');
const n = cfg.events.length + 2;
const sum = join(tmp, 'sum.wav');
const filter = [...chains, `${labels}amix=inputs=${n}:normalize=0:duration=first[a]`, `[a]alimiter=limit=0.63:attack=1:release=60:level=disabled[out]`].join(';');
ff([...inputs, '-filter_complex', filter, '-map', '[out]', '-ar', '48000', '-ac', '2', '-t', String(dur), '-c:a', 'pcm_f32le', sum]);

// 4. Master with a two-pass, linear loudnorm: one fixed gain for the whole mix, so the
//    voice / music / SFX balance in the delivered file is exactly the balance of the stems.
const meas = spawnSync('ffmpeg', ['-hide_banner', '-i', sum, '-af', `loudnorm=I=${masterLufs}:TP=-2:LRA=20:print_format=json`, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
const j = JSON.parse((meas.stderr || '').slice((meas.stderr || '').lastIndexOf('{')));
ff(['-i', sum, '-af', `loudnorm=I=${masterLufs}:TP=-2:LRA=20:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`,
  '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out]);
console.log(`mixed ${cfg.events.length} sfx + music -> ${out} (pre-master ${j.input_i} LUFS, ${j.input_tp} dBTP)`);
