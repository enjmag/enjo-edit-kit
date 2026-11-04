import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBatch, normalizeWords, plannedVariants, scriptMarkdown } from '../scripts/new-batch.mjs';
import { transcriptWords, locateBeats, diffWords, scenesFromBeats } from '../scripts/plan-from-script.mjs';
import { stitchFilter } from '../scripts/stitch-variant.mjs';

const batch = {
  name: 'demo-batch', client: 'demo',
  body: { slug: 'demo-body', title: 'Body', lines: ['Here is the method.', 'Save your seat.'], beats: [{ id: 'b1', anchor: 'Here is the method' }, { id: 'b2', anchor: 'Save your seat' }] },
  hooks: [{ id: 'h01', slug: 'demo-h01', title: 'Hook 1', lines: ["Didn't get a unit at $2,900 psf?"], beats: [{ id: 'b1', anchor: "Didn't get a unit" }] }],
};

test('a valid batch has no problems', () => {
  assert.deepEqual(checkBatch(batch), []);
});

test('a batch flags bad slugs and anchors that are not in the script', () => {
  const bad = structuredClone(batch);
  bad.hooks[0].slug = 'Bad Slug';
  bad.body.beats[1].anchor = 'words never said';
  const problems = checkBatch(bad);
  assert.ok(problems.some((p) => p.includes('kebab-case')));
  assert.ok(problems.some((p) => p.includes('not in the script')));
});

test('normalizeWords makes script and transcript spellings comparable', () => {
  assert.deepEqual(normalizeWords("Didn't get a unit at $2,900 psf?"), ["didn't", 'get', 'a', 'unit', 'at', '2900', 'psf']);
  assert.deepEqual(normalizeWords('Tuesday, 17 November, 7.30pm.'), ['tuesday', '17', 'november', '7.30pm']);
});

test('one planned ad per hook, each followed by the body', () => {
  const v = plannedVariants(batch);
  assert.equal(v.length, 1);
  assert.equal(v[0].body, 'video-projects/demo-body');
  assert.equal(v[0].file, 'demo-batch-h01.mp4');
  assert.match(scriptMarkdown(batch.hooks[0], batch, 'hook'), /plan-from-script/);
});

const transcript = { words: [
  { text: 'Here', start: 0.2, end: 0.4 }, { text: ' ', type: 'spacing', start: 0.4, end: 0.45 },
  { text: 'is', start: 0.45, end: 0.6 }, { text: 'the', start: 0.6, end: 0.7 }, { text: 'method.', start: 0.7, end: 1.2 },
  { text: 'So', start: 1.6, end: 1.8 }, { text: 'save', start: 1.8, end: 2.0 }, { text: 'your', start: 2.0, end: 2.2 }, { text: 'seat.', start: 2.2, end: 2.6 },
] };

test('beats are found in order and turned into scenes', () => {
  const words = transcriptWords(transcript);
  const located = locateBeats(batch.body.beats, words);
  assert.equal(located[0].start, 0.2);
  assert.equal(located[1].start, 1.8);
  const scenes = scenesFromBeats(located, 3);
  assert.equal(scenes[0].start, 0);
  assert.equal(scenes[1].end, 3);
  assert.ok(scenes[0].end <= scenes[1].start);
});

test('the script check reports added and missing words', () => {
  const words = transcriptWords(transcript).map((w) => w.norm);
  const d = diffWords(normalizeWords(batch.body.lines.join(' ')), words);
  assert.ok(d.coverage === 1);
  assert.deepEqual(d.changes.map((c) => c.added), [['so']]);
});

test('stitching fits the body to the hook and joins audio', () => {
  const f = stitchFilter({ width: 1080, height: 1920, fps: 30, hasAudio: true, duration: 10 }, { width: 720, height: 1280, fps: 25, hasAudio: false, duration: 60 });
  assert.match(f, /scale=1080:1920/);
  assert.match(f, /anullsrc/);
  assert.match(f, /acrossfade/);
});
