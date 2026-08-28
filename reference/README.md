# Reference code sets

## ⚠️ The loaded code set is incomplete — demo only

Currently loaded: **CMS Section 111 valid ICD-10, FY2027 (74,099 codes)**.

Section 111 is the **Medicare Secondary Payer reporting** list — liability,
no-fault and workers' compensation. It is *not* the general billing code set,
and it omits codes that are perfectly valid to bill. `Z23` (encounter for
immunization) is absent, and it will not be the only one.

Because of that:

- **Validation is warning-level and never blocks a code.** An unrecognised code
  is flagged for a reviewer, not removed. Blocking on an incomplete list would
  reject correct codes with total confidence, which is worse than not checking.
- **No accuracy claim may rest on this set.** "Validated against the code set"
  is not a true statement while this is what is loaded.
- **CPT and HCPCS are not covered at all.** Procedure codes report as
  *unchecked*, not as valid.

**Before a pilot with real claims**, replace this with the complete ICD-10-CM
release from CMS (free) and license CPT from the AMA. Only then does hard
blocking become the right behaviour. Until then this is a demo aid.


Drop code files into `reference/codes/`. Anything ending `.csv`, `.tsv`, `.txt`,
or `.json` is picked up automatically. Then:

```bash
node reference/inspect.mjs
```

That reports what was read, how it was interpreted, and anything that looks
wrong — run it as soon as you add a file, before assuming it worked.

## 🔒 Read this before exporting anything

**A raw claims, remittance, or EOB export contains PHI** — patient names, dates
of birth, member IDs, and diagnoses tied to individuals. This repository has no
encryption at rest, no audit logging, no retention policy, and no BAA. Do not
put one here.

What is safe is an **aggregate**: one row per code, with a count. No patient
rows, no dates of service, no identifiers.

| Safe | Not safe |
|---|---|
| `J02.9, Acute pharyngitis, 412` | A row per claim or per visit |
| A blank superbill or encounter form | A completed superbill |
| The CMS ICD-10-CM release (public) | An 835 remittance or EOB file |
| Denial *reasons* by code, aggregated | Denial letters naming patients |

If your billing system cannot export that shape, tell me what it *can* export
and I will tell you exactly what to strip before it goes anywhere near here.

## What is most useful, in order

1. **Your own code list with frequencies.** A practice bills maybe 200–400
   distinct codes ever. That list is small enough to cache in the prompt
   permanently and captures real billing patterns no generic code set does.
   This is worth more than everything below it combined.
2. **A superbill or encounter form.** Most practices already have one, and it
   is already the right size.
3. **Denial history, aggregated.** Which codes were rejected and why. Nothing
   else teaches the scrub what actually fails with your payers.
4. **The full ICD-10-CM release.** Free from CMS. Gives validation coverage
   beyond the codes you already use.

## Format

Simplest useful shape — a header row and three columns:

```csv
code,description,count
J02.9,"Acute pharyngitis, unspecified",412
99213,"Office visit, established patient, low complexity",1180
Z23,Encounter for immunization,340
```

Only `code` is required. The loader is forgiving:

- **Delimiters**: comma, tab, pipe, semicolon — detected automatically.
- **Headers**: `Code`, `code`, `ICD10`, `Procedure Code`, `Long Description`,
  `Freq`, `Volume` and similar all resolve correctly. Casing and punctuation
  do not matter.
- **No header**: assumed to be `code, description, count` in that order.
- **Plain lists**: `J02.9 Acute pharyngitis`, one per line, works.
- **JSON**: an array of objects, or of bare code strings.
- **Comments**: lines starting `#` are ignored.
- **Multiple files merge.** A frequency export with no descriptions and a code
  set with no counts combine into one enriched entry per code.

The code system (ICD-10 / CPT / HCPCS) is inferred from each code's shape, so
a `type` column is optional. One case genuinely needs it: a letter followed by
exactly four digits is both a valid HCPCS code (`G0439`, annual wellness visit)
and a valid dotless ICD-10 code (`G0439` = `G04.39`). Shape cannot separate
those, so include a `type` column if your file has many of them.

## How these get used

Two very different jobs, deliberately kept apart:

**Validation** — after the model suggests a code, look it up. Deterministic,
zero tokens. *Today* an unrecognised code is flagged for review and nothing
more, because the loaded set is incomplete (see the warning at the top).
Hard blocking — not in the set, not on the claim — is the P3 behaviour, and it
waits on a complete ICD-10-CM release.

**Retrieval shortlist** — search the set for codes plausibly matching the
encounter and put *those* 20–40 in the prompt, so the model picks from real
codes instead of recalling from memory. A few hundred tokens per encounter.
This is where the accuracy gain lives.

**What we will not do is put a whole code set in the prompt.** ~74,000 ICD-10
codes is roughly 740k tokens per call — about $3.70 per claim in input alone on
Opus 5 — and burying the right code among 74,000 wrong ones makes the pick
worse, not better. Retrieval beats stuffing on both cost and accuracy.

## Not committed by default

`reference/codes/` is gitignored. Practice-specific billing data is yours and
should not land in a shared repository without a deliberate decision, even in
aggregate form. Remove the ignore rule if you decide otherwise.
