---
name: client-brief
description: Set up or complete a client's brief and brand kit before any client edit, so the video serves their offer, audience, objection, proof, CTA, and success metric. Use when starting work for a new client, when a client edit has no complete brief, or when the user shares client details to record.
---

# Client brief

Every client edit starts from `clients/<slug>/`. This skill creates that folder,
fills it with the user, and checks it is complete before editing begins.

## Steps

1. If the folder does not exist, run `npm run new-client -- <slug>`.
2. Read what the user has already given: messages, call notes, the client's
   website, existing ads, reviews. Fill every section of `BRIEF.md` you can from
   those sources, and mark each inferred answer with "(inferred, confirm)".
3. Ask the user only for what is still missing, in one message, grouped and
   short. The offer, CTA, destination link, and proof must come from the user
   or client, never from a guess.
4. Fill `BRAND.md`. Ask for the real logo files and put them in `brand/`.
   Never redraw, trace, or generate a logo. If the client has no brand rules,
   write "none" and use the kit's defaults.
5. Run `npm run check:brief -- clients/<slug>` and fix every reported gap.
6. Summarise the brief back to the user in five lines (who, what offer, main
   objection, CTA, success metric) and ask them to confirm before the first edit.

## Quality bar

- Audience is one specific person, not a demographic.
- Problem and desire use customer language where possible.
- Proof lists real, showable files or links. "We get great results" is not proof.
- The CTA is one action with a working destination.
- The success metric is measurable.

## Privacy

`clients/` is gitignored except the template. Do not move client files elsewhere
in the repository, commit them, or paste them into public places. Never store
passwords or API keys in these files.
