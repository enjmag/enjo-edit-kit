# Editing playbook: how Nate's videos get edited with AI

Nate's reels, Shorts, and explainers are now edited by an AI agent (Claude Code or Codex) running skills like the ones in this kit. Nate records himself talking, hands over the file, and the agent cuts it, captions it, finds the B-roll, builds the motion graphics, mixes the music and sound effects, and checks its own work.

This page explains how that works and what we learned building it. The numbers come from studying Nate's own top reels frame by frame and from dozens of edit rounds where he gave notes.

- [The loop that makes it work](#the-loop-that-makes-it-work)
- [The edit, step by step](#the-edit-step-by-step)
- [House reel style (the numbers)](#house-reel-style-the-numbers)
- [B-roll](#b-roll)
- [Captions](#captions)
- [Music and sound effects](#music-and-sound-effects)
- [Other formats](#other-formats)
- [Checking the edit](#checking-the-edit)
- [Lessons that cost us time](#lessons-that-cost-us-time)

## The loop that makes it work

The edits got good because every note Nate gave became a permanent rule in a skill. He never had to give the same note twice.

1. **Record and hand over the file.** No editing app.
2. **The agent edits and renders a draft.**
3. **You watch it and say what you don't like, in plain words.** "I can't read that caption." "That shot doesn't move." "Those sound effects sound cheap."
4. **The agent fixes the edit AND writes the fix into the skill** as a rule, a check, or a script change. Ask for that explicitly: "Fix it, then add this to the skill so it never happens again."
5. **The next edit starts from the improved skill.**

Real examples of notes that became rules:

| Nate's note | What the skill does now |
|---|---|
| "White captions on a bright website are unreadable." | Every caption sits in the same dark box, and a contrast check measures the pixels behind each one. |
| "AI-generated B-roll always beats AI-generated images." | An AI still image used as B-roll is a build error. Stills only become first frames for AI video. |
| "Every shot has to move." | Each shot is real footage, a screen recording, an animated UI, or AI video, with a slow push-in. No frozen frames. |
| "Those laser sound effects sound cheap." | The sound palette switched to soft taps, dry clicks, paper, and air. No pitch-drop plops or zaps. |
| "The lips are behind the voice by the end." | Cuts select exact frames in one pass, and a sync check compares every cut frame against the raw. |
| "Captions should never blink out." | On shots full of text to read, captions move to a clear zone instead of disappearing. |
| "You cut out my natural pause after 'first', it feels too quick." Then, after a fix that added silence there: "You muted out the word first." | Speech is cut between phrases at real silence, never inside one. A filler that runs straight into the next word stays, because cutting it clips the words around it. |
| "The caption covers my mouth in the first second." | A caption that runs across a cut moves with the cut, and the first 2.5 s are checked frame by frame for anything over the mouth. |

Notes from our own client edits, added the same way:

| Note | What the skill does now |
|---|---|
| "The font on REAL ESTATE STRATEGIST feels lost." (name title subtitle in a different font from everything else) | One type family across the name title, its subtitle, captions, and graphic titles. Vary weight, size, and letter-spacing for hierarchy, never a second unrelated font. |
| "Add a pause after 'short hold' so viewers have time to see the graphic." Then: "Not 1 second, 0.5, or as long as viewers can digest." | Each motion graphic gets a short hold after its key word before the next line: start around 0.5 s and give it only as long as a viewer needs to read it (a simple label less, a dense comparison more). Use the speaker's real pause from the raw; pad only with matching room tone, never frozen frames. |
| "There's a glitch on some cuts, 1 frame before the motion graphic comes in." | Cut points and graphic start times sit on the same frame grid. Frame strips are checked at every graphic entry and exit, not just at cuts. |
| "What I hate most is a two-line subtitle with one word on the second line." | Captions default to one line. A chunk that would wrap is re-split at a phrase boundary instead. Two lines only when a long or fast phrase must stay together, balanced in length, and a single word alone on a line fails the build. |
| "Make the SFX subtle, none on the name lower third. The music is overpowering the voice." | Sound effects sit under the voice, felt more than heard, and name titles get none. The music bed is checked against the voice on the stems after the final loudness step; when a client says it's too loud, widen the voice-to-bed gap (one client landed at about 23 dB under, ducked under speech), not just the master level. |
| "When there's a jump cut, add a bit of zoom to hide the cut." | Every jump cut on the speaker alternates framing with a hard punch-in (about 8 to 12% tighter) on the cut frame. Face stays well framed and captions stay off the mouth. Cuts covered by a full-screen graphic are skipped. |

The editing knowledge lives in the skill files, so you can read it, edit it, and share it.

## The edit, step by step

This is the order the `short-form-edit` and `edit-video` skills follow.

1. **Transcribe** with word-level timestamps (ElevenLabs Scribe is Nate's default; Whisper works).
2. **Cut retakes.** Keep the last clean take of each line. Join two takes only where both sides are silent; if the takes run together, play one take whole.
3. **Cut between phrases, never inside one.** A phrase is what you say in one breath. Remove the dead air between phrases and keep your natural beats (after a comma, after "First,"). Drop a filler only when there is silence on both sides of it: "First, what it does is it transcribes" is one phrase, and cutting "what it does is" clips the word "First". Never speed the voice up.
4. **Plan the story before any visuals:** hook, proof, the items, the payoff, the CTA. Write it down.
5. **Source B-roll**, one visual per noun phrase, in the preference order below.
6. **Build the composition** in HyperFrames, every shot anchored to the spoken word it illustrates.
7. **Mix** voice, music, and sound effects.
8. **Render a draft, check it** (frames, sync, sound, captions), fix, then render the final.

## House reel style (the numbers)

Measured on Nate's 27 top Instagram Reels (March to September 2026). Use them as a starting point for your own style, not as law.

**Pacing**
- Speech starts within 0.1 s. The file ends right after the last word. No intro or outro card.
- No dead air: pauses between phrases stay under about 0.2 s. Natural beats after a comma or a list marker ("First,") run 0.2 to 0.4 s and stay. Typical gap between words is 0.04 s (median) and 0.1 s (90th percentile), at 4.0 to 4.7 words per second. Tightness comes from removing dead air between phrases.
- Shots average 1.1 to 1.4 s, none over about 2.8 s. The first cut lands at 0.6 to 1.0 s, on the first charged word.
- Each item in a spoken list gets its own shot.

**Layouts** (1080x1920; every change is a hard cut)
- **Split:** B-roll on top (y 0 to 880), speaker below. 30 to 42% of the reel.
- **Full B-roll:** footage fills the frame. 50 to 55%.
- **Punch-in:** a tight shot of the speaker for pivots, emphasis, and the CTA. 5 to 15%.
- The speaker is on screen about 45% of the time and never gone for more than about 3.5 s.
- The first frame is a split with the topic's tool or brand on top.

**Story**
1. Hook in the first 3 seconds: a claim or command that names the tool or person.
2. One line of credibility or context.
3. If there's a list, show all items early, blurred, as an open loop.
4. Each item: a section card, a one-line definition, two or three literal visuals, a punch-in on the key line.
5. Resolution that calls back to the hook visual.
6. CTA: show the resource first, then a punch-in with the comment keyword.

## B-roll

**Video beats images, every time.** The reel has to hold attention from the first frame to the last, so every shot moves. Preference order:

1. Real footage of the thing named: the person's talk, the product's demo, your own long-form video.
2. A real screen recording of the site or app, zoomed into the part being talked about, with a visible cursor.
3. An animated UI mock: typing, rows ticking, a counter climbing. Label mocks as examples.
4. AI video. Concrete metaphors work ("burn your money" = a bill burning, "hoping it works" = a slot machine). Generic "person at a computer" clips read as stock.
5. Short highlight crops of a real page (under 1 s) on tool names, prices, badges.

Rules that came from mistakes:
- Never invent numbers, results, or a successful test to decorate a claim.
- A whole web page shrunk to phone size is unreadable. Crop to the phrase and highlight it on the spoken word.
- Small UI floating in empty space is the fastest "AI edit" tell. Zoom UI so it fills the panel.
- Never click "Accept" on cookie or terms dialogs while recording. Close them or use another page.
- AI video models often cut to a second camera angle around 2.5 to 3 s, and text on AI screens turns to gibberish. Use the first continuous seconds and keep screens small in frame.
- Consecutive AI shots of the same person must match (same outfit, same room). Pass the previous frame as a reference.
- Use each B-roll scene once per reel.

## Captions

- 1 to 3 words per chunk, split on phrase boundaries. They hard-swap with no pop animation and appear 2 frames before the first word.
- Montserrat ExtraBold, all caps, about 62 to 64 px, with a heavy serif accent (Abril Fatface) on 5 to 20% of chunks for soft words. Never two serif chunks in a row.
- Color on 25 to 45% of chunks, whole chunk only: red for the wrong way or a loss, teal for the concept or keyword, green for the action or payoff.
- **No orphan words:** one line per chunk by default. Never leave a single word alone on a line; re-split the chunk instead.
- **One look for the whole reel:** every caption in the same dark box with a thin light edge, so it reads on black, white, and footage alike. Mixing boxed and bare captions looked cheap.
- **Never white on light.** Measure the pixels behind every caption.
- Position: on the seam in a split, on the shirt in a punch-in (not the jaw), and in a clear zone when the shot is text to read.
- **Never over the mouth or chin,** least of all in the first second, when the viewer decides whether the person on screen is real. A caption that runs across a cut moves to the new shot's spot on the cut frame.

## Music and sound effects

- **Pick music by mood:** a darker, confident beat for claims and news, lo-fi or chill groove for methods.
- The bed sits about 11 dB under the voice (working range 9 to 14 dB). Duck it under speech. The first 1 to 2 s are often quieter, with the beat landing on the second line.
- **Sound effects follow visible actions,** not every cut: a soft air whoosh on a real spatial move, a damped tap when a logo lands, a dry click for small UI, paper for documents, one short warm tone for a check, a dry stop for an X.
- Avoid laser zaps, pitch-drop plops, sci-fi chirps, and a whoosh on every cut.
- Vary the actual sound files for repeated items (click, tap, ceramic touch) so a list doesn't sound like a percussion loop.
- Master near -14 LUFS with true peak at or below -1.5 dBTP. **Measure the final encoded file,** not just the WAV.
- Never fade the last spoken word.

## Other formats

**Raw reel (lighter style):** no B-roll and no music. Cut retakes, stutters, and dead air only, keeping the last clean take. One word on screen at a time, small, lower middle, synced to the exact word. When the speaker points while naming a tool, pop the tool's real logo where they point with a quiet tap. Cut only after a word fully decays; transcripts end words 40 to 80 ms before the consonant dies.

**YouTube Short from a long-form video:** screen recording on top, face cam below, word-highlight captions on the seam. Put the value or claim in the first 3 seconds, then proofs in the long-form's order, and end on a complete takeaway. Every number on screen must be explainable from what the Short showed. Name things before using them. Keep labels below the top 130 px. Never assemble a CTA the speaker didn't say.

**Narrated explainer (AI voice):**
- Put the whole timeline on one clock (a beat grid) so picture, music, and sound effects all move when a line changes. Never hard-code a time a word should anchor.
- Level every voice line to the same loudness and limit only the peaks. Scaling a whole line down to fit its loudest peak made one line 5 dB quieter.
- Re-transcribe the full narration and compare it to the script before every render.
- Don't play the narrator over footage of a real person talking. Viewers think that person is speaking in the AI voice.
- End on the thesis line, spoken in the decay of the last music hit, then the logo.
- Dim UI panels and waveforms lose viewers. Put real footage in those scenes.

**Event thank-you / confirmation video (16:9, client):** for people who just signed up for a seminar or webinar. The goal is that they show up. Match the client's previous approved video in look and pacing so the series feels consistent. Name title for the first 4 s, captions throughout, one moving graphic per topic the speaker lists (only what they say: no added numbers, names, or claims), then an event card with day, date, time, and venue, checked against what the client confirms rather than the transcript (speech-to-text mishears venue names). Tighten pauses only; keep every word. Add music or a second CTA only when asked.

## Checking the edit

The agent checks its own work before you see it:
- **Lip sync:** match cut frames against the raw. A matching frame count alone does not prove the right frames were picked.
- **Frame strips** across every cut (10 frames each side). They catch one-frame empty panels and captions flashing over the wrong shot that single screenshots miss.
- **Graphic entries and exits:** a frame strip at every graphic in and out. A one-frame flash of the wrong shot before a graphic usually means its start time and the nearest cut fell on different frames.
- **Jump cuts:** every cut on the speaker either changes framing (punch-in) or is covered by a graphic.
- **How to find the cuts on the encoded edit:** `ffmpeg -i edit.mp4 -vf "select='gt(scene,0.01)',showinfo" -f null -` lists every cut's frame time. Place graphic edges at that frame time minus half a frame, and snap any graphic edge within about 0.3 s of a cut onto the cut so the cut hides underneath.
- **Punch-in values that worked:** about 10% tighter than the base framing (one client edit went from 1.25x to 1.38x), transform origin around 50% 30% so the eyes stay in the upper third, reset to the base scale under the next full-screen graphic.
- **Contrast** behind every caption.
- **Every word whole:** transcribe the final render and compare the words at every cut with the raw recording. A transcript alone is not proof: speech-to-text guesses a clipped word correctly while a listener hears it broken.
- **The first second:** read the first 2.5 s frame by frame and the first frame of every face shot. Nothing covers the mouth.
- **Loudness and true peak** on the delivered file.
- **AI watch tests** (a video model watching the render) are useful for candidate problems, but they are noisy and hallucinate effects. Verify every complaint on real frames before acting. A persona panel ("would this viewer finish? where did they stop?") is more useful than a 1 to 10 score.
- **Your review is the final gate.** Nate caught a lip-sync drift that every automated check missed.

## Lessons that cost us time

- Encoding each segment separately and concatenating drifts lip sync by about a frame at half the joins. Select exact frame numbers in one pass.
- Download the full video stream and cut locally; seeking over HTTP for a 3 s clip took 10+ minutes.
- Browser screen recorders capture CSS pixels, so high-DPR recordings come out small. Capture frame by frame instead.
- Some docs sites scroll an inner container; scroll with the mouse wheel, not `window.scrollTo`.
- A dark caption box disappears on a dark background unless it has a thin light edge.
- Animate transforms (x, y, scale), not `top` or `left`.
- Cutting a filler out of the middle of a phrase clips the words around it, and putting a pause there makes the clipped word sound muted. The version that worked had fewer cuts, all between phrases, and ran 5 s longer.
- Measure loudness on the stereo delivery. A mono file reads 3 dB lower and one reel shipped too loud because of it.
- An older FFmpeg build (for example one bundled with another app) can break the silence-cutting script. Install a current FFmpeg first (`winget install Gyan.FFmpeg` on Windows) and make sure it is the one on PATH.
- A font the renderer can't load silently falls back to another. HyperFrames swapped Bebas Neue for the much thinner League Gothic, and Cinzel isn't supported either; Oswald Bold is a close Bebas substitute. Check the compiler's "Injected @font-face" log line and a rendered frame before building around a font, and record the approved fonts in the client's BRAND.md.
- A GSAP `fromTo` shows its starting state from the clip's first frame. Effects that begin later in the clip (ripples, flashes) need `immediateRender: false`, or they sit visible before their cue.
- With FFmpeg 6, the silence-cut script's filter graph can be run with `-filter_complex_script <file>`, mapping `[v]` and `[a]`, if updating FFmpeg isn't possible.
- Preflight flags a root `data-start="0"` when the composition has an inline video, but lint requires it. Keep it; the render validates it.
- A raw recording caps the edit. A clip with no hook and no CTA scores low no matter how well it's cut. Script the hook before you record.
