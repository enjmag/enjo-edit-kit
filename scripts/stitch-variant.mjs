#!/usr/bin/env node
// Join a finished hook and the shared main body into one ad.
//
// Render the hook and the body without music, join them here, then add one music
// bed across the whole ad (scripts/mix-bed.mjs, when available), so the music
// does not restart at the join.
//
// Usage:
//   node scripts/stitch-variant.mjs <hook.mp4> <body.mp4> --out <ad.mp4> [--fade 0.04]
// Both inputs are scaled and padded to the hook's size and frame rate if they differ.
// --fade sets a very short audio crossfade at the join (seconds) so it never clicks.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate:format=duration', '-of', 'json', file], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error(`${file} has no video stream.`);
  const [num, den] = v.r_frame_rate.split('/').map(Number);
  return { width: v.width, height: v.height, fps: den ? num / den : num, hasAudio: Boolean(a), duration: Number(j.format.duration) };
}

/** The ffmpeg filter graph that joins hook and body. */
export function stitchFilter(hook, body, fade = 0.04) {
  const fit = (i) => `[${i}:v]scale=${hook.width}:${hook.height}:force_original_aspect_ratio=decrease,pad=${hook.width}:${hook.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${hook.fps.toFixed(3)},format=yuv420p[v${i}]`;
  const aud = (i, info) => info.hasAudio
    ? `[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`
    : `anullsrc=r=48000:cl=stereo,atrim=0:${info.duration.toFixed(3)}[a${i}]`;
  const join = fade > 0
    ? `[a0][a1]acrossfade=d=${fade}:c1=tri:c2=tri[a]`
    : '[a0][a1]concat=n=2:v=0:a=1[a]';
  return [fit(0), fit(1), '[v0][v1]concat=n=2:v=1:a=0[v]', aud(0, hook), aud(1, body), join].join(';');
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i > -1 ? args[i + 1] : d; };
  const files = args.filter((a, i) => !a.startsWith('--') && !['--out', '--fade'].includes(args[i - 1]));
  const out = opt('--out');
  if (files.length !== 2 || !out) {
    console.log('Usage: node scripts/stitch-variant.mjs <hook.mp4> <body.mp4> --out <ad.mp4> [--fade 0.04]');
    process.exit(1);
  }
  const [hookFile, bodyFile] = files.map((f) => resolve(f));
  for (const f of [hookFile, bodyFile]) if (!existsSync(f)) throw new Error(`Missing ${f}`);
  const hook = probe(hookFile);
  const body = probe(bodyFile);
  if (hook.width !== body.width || hook.height !== body.height) console.warn(`Body is ${body.width}x${body.height}; fitting it to the hook's ${hook.width}x${hook.height}.`);
  const fade = Number(opt('--fade', '0.04'));
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', hookFile, '-i', bodyFile,
    '-filter_complex', stitchFilter(hook, body, fade), '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', resolve(out)],
  { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + (r.stderr || '').slice(-800));
  const joined = probe(resolve(out));
  console.log(`Joined ${hook.duration.toFixed(2)} s hook + ${body.duration.toFixed(2)} s body -> ${out} (${joined.duration.toFixed(2)} s).`);
  console.log(`The join is at ${hook.duration.toFixed(2)} s. Watch and listen across it before mixing music.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
