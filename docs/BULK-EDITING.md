# Bulk editing: one main body, many hooks

Use this when a client records one main body and several hooks, and every ad is
one hook followed by the same body (for example ad hook tests). Plan everything
from the script before the footage arrives, so editing starts the day it lands.

## Before the footage arrives

1. Read the client folder (`clients/<slug>/`) and run `npm run check:brief`.
2. Break the script into beats. Write a batch file next to the client's other
   files (gitignored), for example `clients/<slug>/campaigns/<name>/batch.json`.
   Each hook and the body list their spoken `lines`, `sources`, open `flags`, and
   `beats`. A beat's `anchor` is its first words exactly as scripted, plus the
   plan: `layout`, `visual`, `onScreen`, `sfx`. See `scripts/new-batch.mjs` for the format.
3. Create the projects:

   ```sh
   npm run new-batch -- clients/<slug>/campaigns/<name>/batch.json
   ```

   This makes one project per hook plus one for the body, sets the size and frame
   rate, copies shared assets from a template project (music, SFX, maps), and
   writes `SCRIPT.md` and `script.json` into each. `VARIANTS.json` beside the
   batch file lists every planned ad.
4. Check the script's facts before recording: every number needs a source the
   editor can open. A claim without one is a flag for the user, never a guess.
5. Send the speaker recording notes: same set, light, framing and clothes for
   the body and every hook (they are joined), each hook as its own take with a
   two-second pause before and after, and the body in one continuous take if possible.

## When the footage lands

Edit the body first, because every ad shares it. Then each hook.

1. Silence and mistake cuts as usual; save the edited video's word transcript as
   `assets/transcript.json`.
2. Time the beats and check the take against the script:

   ```sh
   npm run plan:script -- video-projects/<slug>
   ```

   It writes `assets/plan.json` (one scene per scripted beat, so the review board
   shows one card per beat) and `SCRIPT-CHECK.md` (words skipped, added or
   changed, and beats not found). Listen to every flagged line; a wrong number is
   a re-record or a cut, never a caption fix.
3. Build each project with the client's template and verify it as usual.
   Render hooks and the body without music so the bed can run across the join.
4. Review every hook and the body on one board:
   `npm run review -- video-projects/<batch>-body video-projects/<batch>-h01 ...`
   (when the review board is installed). A note on the body fixes every ad at once.
5. Join each hook to the body:

   ```sh
   npm run stitch -- video-projects/<hook>/renders/hook.mp4 video-projects/<body>/renders/body.mp4 --out video-projects/<hook>/renders/<ad>.mp4
   ```

   Then mix one music bed and the SFX across the whole ad, master, and watch and
   listen across the join: matching framing, no jump in level, no clipped word.
6. Fill `VARIANTS.json` with the files and give the user one `PERFORMANCE.md` row
   per ad with the hook type filled in, so results can be compared by hook.

## Order of work

Body, then the hooks in the order the user will test them. Fix a shared problem
once in the body. When the same note lands on several hooks, apply it to all of
them and write the rule once.
