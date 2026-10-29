---
name: review-board
description: Open a beat-by-beat review board for one or many rendered drafts, where the user approves or flags each beat, writes notes, draws on frames, and asks for new ideas; then fix only the flagged beats. Use before delivering any draft, for bulk or batch edits, or when the user says they left review notes or asks to amend.
---

# Review board

The user reviews a draft one beat at a time instead of writing long notes. Each
beat gets a card with its clip, what is said, what is on screen, and the plan for
the beat, plus Approve, Change, Draw, Upload reference, and New idea. Decisions
save into `<project>/review/REVIEW.json`. Claude then changes only the beats the
user flagged and leaves approved beats untouched.

## 1. Before the user sees the board

1. Render a draft (see `../hyperframes-cli/SKILL.md`) and finish the usual
   verification, so the user is not reviewing problems a check would catch.
2. Beats come from `assets/plan.json` scenes, otherwise from the root
   `index.html` sub-compositions (`data-composition-src`), otherwise from equal
   chunks (`--every <seconds>`). Give each sub-composition an HTML comment directly
   above it that says what the beat is for; the board shows it as "Plan for this beat".
3. Pre-check every beat and write `<project>/review/precheck.json`:

   ```json
   {"beats": {"beat-2": {"level": "flag", "note": "Headline lands 0.4 s after the word 'text'."},
              "beat-1": {"level": "ok", "note": "Hook names the benefit by 2 s."}}}
   ```

   Keys are the beat keys the board prints (scene id, element id, or `part-N`).
   Judge each beat against the client's BRIEF.md, RULES.md and BRAND.md (for client
   work), `docs/EDITING-PLAYBOOK.md`, and
   `../short-form-edit/references/quality-gates.md`. Inspect the encoded frames
   for that beat; do not judge from the HTML alone. Flag only real problems with
   a specific reason and time. Say "ok" only for beats you actually inspected.
   This check is an internal review, never audience data or a predicted result.

## 2. Open the board

```sh
npm run review -- video-projects/<slug>
```

For a batch, pass several projects or `--all`; the first page lists every video
with its approved, to-change, and waiting counts:

```sh
npm run review -- video-projects/ad-1 video-projects/ad-2 video-projects/ad-3
npm run review -- --all
```

It serves on `http://127.0.0.1:4848/` and opens the browser. Use `--video <file>`
for a specific render and `--port 4849` if the port is busy. The window must stay
open while the user reviews. Tell the user in one line what to do: watch each
beat, press Approve or Change, type or draw the change, then say "I left review
notes on <slug>, let's amend."

## 3. Apply the notes

When the user says they left notes:

1. Print the to-do list: `npm run review -- video-projects/<slug> --notes`.
   Open every drawing and reference image it lists and look at it.
2. Change only beats marked change. "New idea" means a fresh concept for that
   beat, not a tweak: propose it in the beat's plan comment, then build it.
   If a note is unclear, ask about that beat only and keep working on the rest.
3. Keep approved beats byte-for-byte unless a flagged beat's change forces a
   seam fix next to it; say so when that happens.
4. Re-run preflight, lint, beat-sync, render the draft, and inspect the changed
   beats and their seams in the encoded video.
5. Send the fixed beats back for review:
   `npm run review -- video-projects/<slug> --mark-revised b02,b05`.
   This keeps the old note in the beat's history and starts the next round.
6. Turn each note into a rule, as the workspace guide requires: add it to the
   client's `RULES.md` with its source (for example "Review board, round 1, b02").
   If it would apply to any client, also add it to `docs/EDITING-PLAYBOOK.md`
   or the relevant skill. Never make the user give the same note twice.
7. Reopen the board so the user can check the revised beats. Repeat until every
   beat is approved, then do the final render.

## Bulk editing

Run the pre-check on every video before opening the board, so the user's time
goes to the beats you flagged and to taste decisions only they can make. When the
same note appears on several videos, fix it in all of them, write the rule once,
and say which videos it touched. Apply notes video by video and mark each one
revised separately.

## Output

Reply with the board link or command, then after a round: how many beats changed,
which rules were added, and that the board is ready for the next look.
`review/` lives inside the gitignored project folder; never commit it.
