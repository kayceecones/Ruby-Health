# Ruby Health — working notes for Claude

## What this is

A prototype claims tool. It takes a recording of a patient visit, pulls out the
clinical facts, suggests ICD-10 and CPT codes, and drafts an insurance claim for
a human to review.

It is **not** the production system. No encryption at rest, no audit logging, no
retention policy, no BAA.

---

## Standing rules

These are the things most likely to get broken by someone trying to be helpful.

**Synthetic encounters only. Never real patient data.** Not in the app, not in
`reference/codes/`, not in a test fixture. The compliance layer does not exist
yet. See `CONTRIBUTING.md`.

**Code validation warns; it never blocks.** `backend/src/pipeline/validateCodes.js`
flags an unrecognised code and leaves it on the claim. This looks like a missing
feature and is not. The loaded code list is the CMS Section 111 list (Medicare
Secondary Payer reporting), which omits codes that are perfectly valid to bill —
`Z23`, encounter for immunization, is absent. Blocking on an incomplete list
would reject correct codes with total confidence. Hard blocking is P3 work and
waits on a complete ICD-10-CM release. See `reference/README.md`.

**Do not quote an accuracy number from the eval suite.** The answer key in
`eval/encounters/` was written by an AI, not a certified coder. It is a
regression detector — "did this change help or hurt?" — not a statement about
real-world accuracy. A confidently wrong key is worse than none, because it
makes a guess look authoritative.

**The model IDs are correct. Do not "fix" them.** `claude-opus-5` (claim path)
and `claude-haiku-4-5` (transcript cleanup) are real, current model IDs,
verified against the SDK's own `Model` union. They look unfamiliar if your
training data predates them. **Load the `claude-api` skill before touching any
Anthropic API code** — never answer from memory on model names, pricing, or
caching.

---

## Where things live

| Folder | What's in it |
|---|---|
| `backend/` | Express server + the pipeline that calls Claude. The only npm package in the repo. |
| `frontend/` | One file, `index.html` — ~1,460 lines, vanilla JS, no build step, no framework. |
| `eval/` | Accuracy test suite: 20 synthetic encounters, a scorer, a runner. |
| `reference/` | Loader for ICD-10/CPT code lists, used for validation. |
| `docs/` | `mvp-v1-build-plan.html` — the P0–P6 build plan. |
| `test/` | `ui-smoke.mjs`, a browser test. Needs Playwright, which is not a project dependency. |

**Watch out:** folders import across each other, and those paths are
load-bearing. `eval/score.mjs` imports from `../backend/src/pipeline/`, and
`backend/src/server.js` imports from `../../reference/loadCodes.mjs`. Moving
files breaks things quietly.

---

## Running and testing

```bash
cd backend && npm install && npm start     # needs ANTHROPIC_API_KEY in backend/.env
```

**There is no single command that runs all the tests.** There are four:

```bash
cd backend && npm test                  # 23 tests
node --test eval/test/*.test.js         # 19 tests
node --test reference/test/*.test.js    # 14 tests
node eval/run.mjs --mock                # harness check, no API calls, free
```

56 tests total. CI (`.github/workflows/ci.yml`) runs all four plus a boot check.

A root `package.json` would unify them, but Render builds the service with
`cd backend && npm install` and reads config from the repo root — not worth
risking a working deploy to save typing.

**A real eval run costs about $1.50** (one model call per encounter):
`node eval/run.mjs`. `--mock` scores 100% by construction; it proves the harness
works, nothing more.

---

## How the pipeline works

Five stages. The split between "asks Claude" and "plain arithmetic" is the main
design line in this project — keep it sharp.

| Stage | File | Calls a model? |
|---|---|---|
| Clean up transcript | `cleanupTranscript.js` | Yes — cheap model. Leaves the claim path in P2. |
| Extract clinical facts | `extract.js` | Yes |
| Suggest codes | `suggestCodes.js` | Yes |
| Check quotes are real | `verifyQuotes.js` | **No** — string matching |
| Validate codes | `validateCodes.js` | **No** — list lookup |
| Build the claim | `populateClaim.js` | **No** — deterministic |

**Adding a stage that calls Claude?** Follow the existing shape: one async
function taking `(anthropic, model, …)`, a `SYSTEM_PROMPT`, a single forced tool
call, then `recordUsage(stage, model, response)` immediately — so no call
escapes token accounting. Then give every field of `toolUse.input` a default.
Never trust raw model output: `JSON.stringify` drops `undefined` keys, and that
caused a real crash before the defaults were added.

---

## House style

- **Comments say why, not what.** If the code is readable, it doesn't need a
  comment. If a decision looks wrong without context, explain the context.
- **Tests use Node's built-in runner** (`node:test`, `node:assert/strict`). No
  Jest, no Mocha, no Vitest. Files are `<module>.test.js` in a sibling `test/`.
- **Branch off `master`, come back through a PR.** Nothing pushed straight to
  master. See `CONTRIBUTING.md`.
- Auto-deploy on commit is a **prototype-only** arrangement. Production needs
  review gates — that distinction is written down in `CONTRIBUTING.md`.

---

## Working with Kaycee

**Start plans with a plain-language summary**, before any technical detail: what
we're doing, why, and what actually changes.

**Give every step a plain-English description** alongside the technical one. Not
jargon with an explanation appended — the plain version should stand on its own.

**One piece at a time.** Prefer a short response with a single clear next step
over a complete rundown of everything at once. Long responses lose the thread.

---

## Where things stand

P0 (correctness fixes) and P1 (the eval suite) are done. **P2 is next**: merge
the extraction and coding calls into one, drop the transcript rewrite from the
claim path, and add a cached block of E/M coding guidance.

Full plan: `docs/mvp-v1-build-plan.html`. Running log: the "Ruby Health MVP Demo
— Build Log & Next Steps" page in Notion.

**Two things to know before you start:**

- **There is no baseline eval score yet.** Nobody has run the suite against a
  live server. Until that happens there is nothing to measure P2 against.
- **`reference/codes/` is gitignored**, so a fresh clone has no code list. The
  server handles this — validation reports `unchecked` instead of failing.
