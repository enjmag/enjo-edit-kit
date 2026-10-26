---
name: performance-review
description: Turn real results from published client videos into editing rules. Reads clients/<slug>/PERFORMANCE.md (or analytics exports the user supplies), compares hooks and story structures, and writes evidence-backed rules into RULES.md. Use when the user shares video or ad metrics, asks what is working, or asks to improve the edits based on results.
---

# Performance review

Nate's kit improves by turning review notes into rules. This skill does the
same with real audience data, so each client's edits get better from evidence,
not taste alone.

## Inputs

- `clients/<slug>/PERFORMANCE.md` rows, or a CSV or screenshot of platform
  analytics the user provides. Add any new rows to `PERFORMANCE.md` first,
  copying numbers exactly. Leave unknown cells blank.
- `assets/VARIANTS.json` and DESIGN.md from the matching video projects, to see
  what each hook and structure actually was.
- The brief's success metric, which decides what "worked" means.

## Steps

1. Check the data is enough to judge. Note impressions or spend per row. Treat
   a difference as a signal only when each side has a reasonable sample (as a
   rough guide, a few thousand impressions or a meaningful ad spend each) and
   the gap is large. Otherwise call it "early, keep testing".
2. Compare by hook type, story structure, length, and opening visual. Lead with
   the brief's success metric, then hook rate and hold rate as supporting signals.
   A high hook rate with no conversions is not a win.
3. Watch the top and bottom performers' first 3 seconds and CTA (or their
   rendered frames) and say what differs in plain words.
4. Write findings as rules in `clients/<slug>/RULES.md`: date, the rule, and the
   evidence (rows and numbers). Mark weak evidence as a hypothesis to test.
   Remove or soften an older rule the new data contradicts, and say so.
5. Propose the next test: which hook types or structures to try in the next
   variant set, and why.
6. If the same pattern holds across two or more clients, offer to add it to
   `docs/EDITING-PLAYBOOK.md` or the relevant skill as a general rule.

## Output

Reply with: the top finding in one sentence, a small table of results by hook
type or structure, the rules added or changed, and the next test. Never invent,
round up, or extrapolate numbers, and never present internal reviews or AI
watch tests as audience data.
