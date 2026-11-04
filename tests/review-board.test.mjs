import test from 'node:test';
import assert from 'node:assert/strict';
import { beatsFromIndex, beatsFromPlan, beatsByChunks, spokenIn, mergeReview, applyUpdate, markRevised, summarize, notesText, visibleText } from '../scripts/review-board.mjs';

const index = `
<div id="root" data-composition-id="main" data-start="0" data-duration="8">
  <!-- intro note that belongs to nobody -->
  <video data-start="0" data-duration="8" src="a.mp4"></video>
  <!-- BEAT 1: hook lands on "money" -->
  <div id="beat-1" class="scene-layer" data-composition-id="hook" data-composition-src="compositions/hook.html" data-start="0" data-duration="3" data-track-index="4"></div>
  <div id="beat-2" class="scene-layer" data-composition-id="proof" data-composition-src="compositions/proof.html" data-start="3" data-duration="5" data-track-index="4"></div>
</div>`;
const comps = { 'compositions/hook.html': '<template><div>Save <b>$300</b><style>.x{}</style><script>tl.to(1)</script></div></template>', 'compositions/proof.html': '' };

test('beats come from timed sub-compositions with their own comment and on-screen text', () => {
  const beats = beatsFromIndex(index, (src) => comps[src]);
  assert.deepEqual(beats.map((b) => [b.key, b.start, b.end]), [['beat-1', 0, 3], ['beat-2', 3, 8]]);
  assert.equal(beats[0].intent, 'BEAT 1: hook lands on "money"');
  assert.equal(beats[1].intent, '');
  assert.equal(beats[0].onScreen, 'Save $300');
});

test('plan scenes, equal chunks, and spoken words', () => {
  assert.deepEqual(beatsFromPlan({ scenes: [{ id: 's00', start: 0, end: 2, kind: 'hook', layout: 'face' }] }).map((b) => [b.key, b.label]), [['s00', 'hook · face']]);
  assert.deepEqual(beatsByChunks(7, 3).map((b) => [b.start, b.end]), [[0, 3], [3, 6], [6, 7]]);
  const words = [{ text: 'Stop', start: 0.1 }, { text: 'wasting', start: 0.4 }, { text: 'money.', start: 2.9 }, { text: 'Here', start: 3.2 }];
  assert.equal(spokenIn(words, 0, 3), 'Stop wasting money.');
  assert.equal(visibleText('<p>a &amp; b</p>'), 'a & b');
});

test('decisions survive a rebuild and only flagged beats are sent back', () => {
  const beats = beatsFromIndex(index, (src) => comps[src]);
  let review = mergeReview(null, beats, { project: 'demo' });
  assert.deepEqual(summarize(review), { approved: 0, change: 0, waiting: 2, total: 2 });
  applyUpdate(review, 'b01', { status: 'approved' });
  applyUpdate(review, 'b02', { status: 'change', note: 'Make the number yellow' });
  assert.throws(() => applyUpdate(review, 'b02', { status: 'maybe' }));
  assert.match(notesText(review), /b02 \(beat-2, 3s-8s\): Make the number yellow/);

  review = mergeReview(JSON.parse(JSON.stringify(review)), beats);
  assert.equal(review.beats[0].status, 'approved');
  assert.equal(review.beats[1].note, 'Make the number yellow');

  markRevised(review, ['b02']);
  assert.equal(review.round, 2);
  assert.equal(review.beats[0].status, 'approved');
  assert.deepEqual([review.beats[1].status, review.beats[1].note, review.beats[1].revisedInRound], ['waiting', '', 1]);
  assert.equal(review.beats[1].history[0].note, 'Make the number yellow');
  assert.throws(() => markRevised(review, ['b09']), /Unknown beats: b09/);
});
