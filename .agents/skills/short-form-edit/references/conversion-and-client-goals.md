# Conversion and client goals

Use this when the edit is for a client, an offer, or an ad. The house style in
`docs/EDITING-PLAYBOOK.md` was measured on organic creator reels whose CTA is a
comment keyword. Client work is judged by the brief's success metric instead,
so the story has to move one specific viewer to one specific action.

Creative quality still comes first. A conversion edit that looks generic or
pushy loses attention before it can sell. The goal is an edit that is worth
watching and makes acting the obvious next step.

## 1. Read the client folder first

Before planning, read `clients/<slug>/BRIEF.md`, `BRAND.md`, `RULES.md`, and
`PERFORMANCE.md`. Run `node scripts/check-brief.mjs clients/<slug>`; if it fails,
use the `client-brief` skill to fill the gaps with the user before planning.
Never fill a missing offer, CTA, or proof with a guess.

Write a short "Brief to edit" table at the top of DESIGN.md:

| Brief field | How this edit serves it |
| --- | --- |
| Audience | Which line or image makes this viewer feel addressed in the first 3 s |
| Problem and desire | Where the pain shows, where the desired outcome shows |
| Main objection | The exact moment it is answered, and with what proof |
| Proof | Which real assets appear, at what times |
| CTA | Exact wording, where it appears on screen and in speech |
| Success metric | What this edit is optimised for (hook rate, clicks, leads) |

`RULES.md` overrides the house style for this client. `PERFORMANCE.md` tells you
which hooks and structures have actually worked; prefer them, and say so.

## 2. Pick a story structure from the goal

Choose one structure and record why in DESIGN.md. The speaker's real footage
decides what is possible; do not force a structure the recording cannot support.

| Goal | Structure | Shape |
| --- | --- | --- |
| Cold audience, paid ad | Problem, agitate, solve | Name the pain, show its cost, reveal the offer as the fix, proof, CTA |
| Clear transformation | Before, after, bridge | Show the after early, the before for contrast, the offer as the bridge, CTA |
| Product or software | Demo, proof, offer | Show it working within 3 s, one result, one objection answered, CTA |
| Trust is the barrier | Testimonial stack | Strongest customer line first, two or three short proofs, CTA |
| Crowded market | Myth, truth | A belief the viewer holds, why it fails, the better way, CTA |
| Warm audience, organic | Value first | Teach one useful thing completely, then a soft CTA tied to it |

Every structure keeps the kit's rules: earn the payoff inside the video, one
main open loop, close it before the CTA, no padding.

## 3. Make the CTA land

- One CTA per video, worded exactly as in the brief. Say it and show it.
- Show what the viewer gets when they act (the page, the freebie, the booking
  screen) before or while the CTA is spoken, using real screenshots or footage.
- The CTA must match the destination: same offer, same price, same words. A
  mismatch between the ad and the landing page wastes the click.
- Give a reason to act now only if it is true (a real deadline, real limited spots).
- For paid ads, the CTA can come earlier and repeat once near the end. For
  organic, keep it after the payoff so the video stands on its own.
- Keep CTA text inside the platform safe zone and on screen for at least 1.5 s.

## 4. Proof and honesty

Use only proof listed in the brief or supplied by the client. Never invent a
number, testimonial, result, logo, or customer. Label demos and mock-ups as
examples. Keep qualifiers the speaker said ("most clients", "in 90 days").
Respect the must-avoids and industry rules in the brief. If a claim needs
evidence the brief does not provide, flag it to the user instead of showing it.

## 5. Export hook variants

For paid ads, and whenever the brief asks for testing, deliver several hooks on
the same body so the client can test what stops the scroll.

1. Keep the three opening drafts you already build. Polish the best 3 to 5,
   each using a different hook type (result-first, problem-first, question,
   bold claim, testimonial, demo). Use hooks that worked in `PERFORMANCE.md` first.
2. Each hook is 2 to 5 seconds of real retained speech or a true visual, and it
   must lead naturally into the shared body. Do not record new claims.
3. Render each as a full video: `<client>-<video>-h1.mp4`, `-h2.mp4`, and so on.
4. Save `assets/VARIANTS.json`:

```json
[
  { "id": "h1", "hookType": "result-first", "structure": "demo-proof-offer",
    "firstLine": "This booked 14 calls last week", "file": "renders/acme-demo-h1.mp4",
    "why": "Result-first won twice in PERFORMANCE.md" }
]
```

5. Give the user a ready-to-paste row per variant for `PERFORMANCE.md` with the
   hook type and structure filled in and the metric columns blank.

## 6. Platform checks

- Works muted: the problem and the offer are clear from picture and captions alone.
- First frame is meaningful (it is the thumbnail in many feeds).
- Length fits the brief and platform; cut, don't speed up speech.
- Safe zones: for 1080x1920 keep text inside x 90 to 930, y 200 to 1600.
- Brand colours, fonts, and caption look from `BRAND.md`; logos from `brand/` only.

## 7. Add to VERIFY.md

Add a "Client fit" section with: brief check passed, the Brief to edit table
filled, CTA wording and destination matched, every proof asset traced to the
brief, must-avoids respected, variant files and VARIANTS.json listed. These are
editorial checks; only real results in `PERFORMANCE.md` show whether it converts.
