# Clients

One folder per client. Every client edit starts by reading that client's folder,
so the edit serves their offer, audience, and goal instead of a generic style.

```sh
npm run new-client -- acme-fitness
npm run check:brief -- clients/acme-fitness
```

| File | What it holds | Who updates it |
| --- | --- | --- |
| `BRIEF.md` | Offer, audience, objection, proof, CTA, platform, success metric | You, with the client, before the first edit |
| `BRAND.md` + `brand/` | Logo files, fonts, colours, caption look, words to avoid | You, once per client |
| `RULES.md` | Notes from this client's reviews and data, written as rules | The agent, after every round of notes or results |
| `PERFORMANCE.md` | One row per published video: hook, structure, real metrics | You add the numbers, the agent reads them |

## Privacy

This kit's GitHub repository may be public (a fork of a public repo is public).
Everything in `clients/` except `README.md` and `_template/` is gitignored, so
briefs, brand files, and results stay on your computer. Keep it that way unless
the repository is private and the client has agreed. Never paste API keys or
ad-account logins into these files.

## How the pieces connect

1. `client-brief` fills and checks `BRIEF.md`.
2. `short-form-edit` or `edit-video` reads the brief, brand, and rules before
   planning, and uses [conversion-and-client-goals.md](../.claude/skills/short-form-edit/references/conversion-and-client-goals.md)
   for the story structure and hook variants.
3. After the video runs, `performance-review` reads `PERFORMANCE.md`, finds what
   worked, and turns it into rules in `RULES.md`.
