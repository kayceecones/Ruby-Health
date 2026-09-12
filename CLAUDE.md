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

## UI structure

`frontend/index.html` has one set of layout primitives, defined once under
"Shared layout primitives" in the `<style>` block. **Use them. Do not invent a
new heading, box, or empty-state class** — if a new section needs something
these can't express, change the primitive rather than adding a sibling.

Three levels, and nothing between them:

| Level | Class | Rule |
|---|---|---|
| Page | `.page-title` / `.page-subtitle` | **Exactly one per visible view.** Says where you are. |
| Section | `.section-title` | Names the group directly below it. Every group gets one. |
| Item | `.card` (+ `.card-head` / `.card-title` / `.card-subtitle`) | One thing in that group. |

Plus: `.empty-state` for "there's nothing here yet" — the only one. `.tabs` /
`.tab` / `.tabpanel` for tabbed content — the only ones; the left sidebar's
`.nav-item` drives `.tabpanel` too.

Two rules that are easy to break by accident:

- **One page title per view.** A History drill-down renders its own
  `.page-title`; that's why the root's title lives inside `#historyRoot` rather
  than above it. Two at once means the top one is lying about where you are.
- **A section title must not be out-sized by its own contents.** `.section-title`
  is a small uppercase label on purpose — it groups without competing with the
  `.card-title`s underneath it.

Spacing above a section title is handled by the stylesheet
(`.card + .section-title`), so no call site sets its own margin. JS finds
content by `data-` hooks, not by style class, so restyling can't break behavior.

### Adding a section to a History view

History views are built from a **declared skeleton, filled by name** — never by
appending in document order. To add a section, add it to that view's `sections`
list and fill its slot:

```js
const slots = renderDetailView(historyCaseViewEl, {
  title: caseObj.title,
  subtitle: `${caseObj.caseId} · ${patient.name}`,
  sections: [
    { name: "encounters", title: "Encounters" },
    { name: "notes", title: "Case notes" },     // <- new section goes here
  ],
});
fetchHistoryList(slots.encounters, ...);
loadCaseNotes(slots.notes, ...);                 // lands in its own slot
```

The position is decided by the `sections` list, not by which fetch finishes
first. **Do not `appendChild` onto a view container** — that is what put things
in the wrong place before.

Two more rules for these views:

- **`showHistoryView(name)` is the only way to switch views.** It hides every
  sibling. Hiding them by hand is how opening an encounter from the activity
  feed used to leave the whole root list on screen above it.
- **Tabs come from `buildTabbedPanels()`.** It carries the `role="tablist"` /
  `aria-selected` wiring and arrow-key navigation. Don't hand-roll a tab strip.

### Adding a field to the Facts card or Claim form

Same contract on the New Claim side: the shape is a list, and the code fills
slots by name. `FACT_FIELDS` declares the Facts card's fields (`kind` is
`text`, `chips` or `quotes`); `CLAIM_GROUPS` declares the Claim form's
fieldsets, filled through `renderFieldGroups()`. Adding a field or a group is
an entry in that list — not another `appendChild` in the middle of a render
function.

### "Context", not "transcript"

The first stage is **Context** everywhere a provider reads it: what they bring
to the encounter, however they brought it — recorded, pasted or typed.

**The stored stage key is still `transcript`**, and so is the `transcript`
field on the API. That is deliberate, not a half-finished rename: the stage is
a Notion select option carried by every artifact already written, so renaming
it is a data migration. If you rename it, migrate the stored rows in the same
change — and leave the API field alone unless you version the endpoint.

### Editing, and workspaces

The four editors — facts, codes, claim and the transcript field — take an
explicit **workspace** rather than reaching for the global `state`. A workspace
is whatever is being edited: `claimWorkspace` (the New Claim session state) or
one built from an encounter's stored artifacts in the record view. It carries
the data plus two calls:

- `touched(stage)` — an edit happened; persist however this workspace does
- `rerender(stage)` — redraw that stage's editor

**A handler must capture its workspace at render time.** Reading a global at
click time would edit whichever record happens to be open seconds later.

The record view is editable until the payer has seen the claim — that is,
until any claim on the encounter leaves `draft` (`encounterIsLocked`). After
that it renders the read-only views with a line saying why, because the record
is what was billed. **If the claims lookup fails, the record stays locked**: it
must not unlock something it cannot vouch for.

Edits write a **new artifact version** with `createdBy: "provider_edit"`, never
an overwrite — so the revision list keeps the trail and a submitted claim still
points at the artifact it was built from. Saves are debounced and always show
their state; a silent save on a medical record is worse than a slow one.

Pipeline actions — extract, suggest codes, populate, submit — stay on New
Claim. The record view edits the record; it does not re-run the pipeline.

### Links

**One link treatment, and it is `.rh-link`.** Ruby paired with an underline —
never colour alone, because colourblind users and low-contrast displays lose a
colour-only affordance.

It is reserved for **the name of an object you can open**: a patient, case,
encounter or claim. Nothing else borrows it — not buttons, not a code, not a
status. If a name carries the treatment it must navigate; if it navigates it
must carry the treatment.

- **Inline names** go through `objectLink(text, onClick)`. Don't hand-build one.
- **Whole-row links** put `.rh-link` on the row's title span. The row button is
  the click target — a `<button>` inside a `<button>` is invalid HTML.
- **Payer and provider have no views**, so their names stay plain text until
  those pages exist. Don't style them as links in the meantime.

### Routes

Three places in the rail, and one shared record view:

| Route | What it is |
|---|---|
| **New Claim** | the pipeline: transcript → facts → codes → claim |
| **Patients** | everyone on file, then patient → case → encounter |
| **History** | claims bucketed by what they are waiting on |
| `record` | one patient, case or encounter — **not** a rail destination |

Patients and History both open the record, so it is its own route rather than
living inside either. `recordOrigin` is set before navigating and stamped onto
`historyState`, which decides two things: the first breadcrumb crumb, and which
rail item stays lit. Leaving the record clears that trail. If you add another
way in, set `recordOrigin` first or the breadcrumb will claim the wrong path.

The sidebar is shared, not New Claim's. It sits beside the routes and carries
one `.nav-group` per route — pipeline steps on New Claim, claim buckets on
History — and hides itself where a route has no nav. A vertical nav comes from
`buildTabbedPanels(..., { orientation: "vertical" })`, the same component as the
horizontal tabs, so both keep the same ARIA and keyboard wiring.

History's buckets are `CLAIM_BUCKETS` — a list with a `match` on claim status.
Add a bucket there, not by hand-building another tab strip. The one without a
`match` is All history, which is the activity feed rather than a slice of the
claims.

### Acting on a claim from History

History reads the record; it does not edit it in place. The exception is
acting on a claim, which a provider has to be able to do from where they are
looking at it. `renderClaimActions()` is the one place that decides what a
claim offers, keyed on its status — a `draft` claim gets **Submit**, anything
the payer has seen gets **Amend**, and an appeal appears only where a denial
left money at risk. Add a pathway there, not by hanging another button off a
card, so a card can never offer an action its status cannot support.

Irreversible actions sit in a `.submit-actions` block: set apart behind a
rule, never flush against content someone was only reading. Amend rows default
to **Keep** — dropping a code is an explicit choice, never implied by an empty
field.

### Color

`--gold` is decorative only — dots, rules, borders. It fails WCAG AA as text.
Anything readable uses `--gold-text`. Before using a color for text, check it
against `--surface` at 4.5:1 (3:1 for large bold text).

---

## Working with Kaycee

**Start plans with a plain-language summary**, before any technical detail: what
we're doing, why, and what actually changes.

**Give every step a plain-English description** alongside the technical one. Not
jargon with an explanation appended — the plain version should stand on its own.

**One piece at a time.** Prefer a short response with a single clear next step
over a complete rundown of everything at once. Long responses lose the thread.

**Push finished commits to their feature branch as soon as they're ready** --
don't leave them sitting local-only. This isn't optional busywork: Claude Code
sessions run in ephemeral cloud containers, and a commit that's never pushed can
be lost for good if the container gets recycled before anyone notices.

**Never merge a PR into `master`, or push directly to `master`, without an
explicit go-ahead for that specific merge/push.** Master auto-deploys to the
live Render site on every commit, so that's the boundary that needs a human
green light -- feature-branch pushes don't.

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
