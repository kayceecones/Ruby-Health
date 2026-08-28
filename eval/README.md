# Accuracy evaluation

Before this existed, every prompt change was verified by running one encounter
and looking at the result. That tells you nothing about whether the change
helped: it cannot distinguish a real improvement from a lucky example, and it
cannot detect a change that fixed one case while quietly breaking four others.

This suite turns "is it more accurate?" from an opinion into a number.

## Running it

```bash
# Against a local server (needs ANTHROPIC_API_KEY in backend/.env)
cd backend && npm start &
node eval/run.mjs

# Against a deployed instance
node eval/run.mjs --base https://ruby-health-demo.onrender.com

# A subset, while iterating on one case
node eval/run.mjs --only 002,014

# Harness check: no API calls, no cost
node eval/run.mjs --mock
```

**A real run calls the model once per encounter** — roughly $1.50 for the full
suite at current pricing. That is cheap enough to run on every prompt change,
which is the entire point of building it before P2 rather than after.

Each run writes a timestamped scorecard to `results/`. Commit the ones worth
comparing against.

## What it measures

| Metric | Question it answers |
|---|---|
| Diagnosis recall | Did it find the diagnoses a coder would have coded? |
| Procedure recall | Did it find the procedures that were actually performed? |
| E/M exact / within one | Did it pick the right visit level, and if not, how far off? |
| Linkage accuracy | Does each service line point at the diagnosis that justifies it? |
| Quote grounding | Are the medical-necessity quotes genuinely in the transcript? |
| Necessity phrase recall | Did it capture the phrases that carry the justification? |
| Forbidden codes | Did it emit a code the key says is wrong for this encounter? |
| Upcoded levels | How often did it code *higher* than the key? |

Two design decisions worth knowing about:

**Accepted alternates.** Real coders disagree at the margins, so a fixture can
list alternates (`J02.9` for `J02.0`). An eval that punishes a defensible
alternate measures conformity, not accuracy.

**Upcoding is tracked directionally.** `emUpcodedCount` counts levels coded
*above* the key. Under-coding costs the practice revenue; over-coding is what
draws an audit. They are not the same failure and are not averaged together.

**Codes beyond the key are reported, not penalised.** A code the key does not
list may still be defensible. It is surfaced for review rather than scored as
an error — but a code in `mustNotCode` is a hard failure.

## The fixtures

20 synthetic encounters in `encounters/`, each targeting a distinct failure
mode rather than padding the count:

- Multi-problem visits, where the wrong diagnosis pointer is a denial (002, 013)
- Laterality and specificity traps, where "unspecified" is a real-world denial
  (004, 014)
- E/M discrimination across the ladder, from 99211 to 99215 (015, 018, 006, 016)
- Acute-on-chronic, where the exacerbation code beats the base disease (012)
- Preventive plus problem in one visit (008)
- Deliberately thin documentation, where the correct behaviour is to code
  conservatively rather than invent specificity (007)
- A procedure explicitly *declined*, which must not be coded (009)
- A patient contradicting themselves, where a confident quote would be wrong (019)
- A service with no stated justification, where necessity language should be
  absent rather than fabricated (020)

## ⚠️ The answer key needs a coder's review

**These fixtures and their expected codes were written by an AI, not a
certified professional coder.** They are a well-structured starting point, not
a validated ground truth.

An answer key that is confidently wrong is worse than no answer key, because it
converts a guess into a number that looks authoritative. Before any accuracy
figure from this suite is quoted to a design partner, an investor, or in a
compliance document, have a certified coder review `encounters/*.json` — in
particular the `emLevel` and the specificity of each ICD-10 code.

Until that review happens, treat the scorecard as a **regression detector**
(did this change make things better or worse than the last run?) rather than as
a statement of real-world accuracy.

## Adding an encounter

Drop a JSON file in `encounters/`. The runner picks it up automatically.

```json
{
  "id": "021-short-description",
  "tests": "What failure mode this case exists to catch.",
  "transcript": "Dictated encounter, punctuated.",
  "expected": {
    "diagnoses": ["J02.0"],
    "diagnosisAlternates": { "J02.0": ["J02.9"] },
    "procedures": ["87880"],
    "emLevel": "99213",
    "links": { "87880": ["J02.0"] },
    "mustNotCode": ["J45.909"],
    "groundingPhrases": ["three days"]
  }
}
```

Every field is optional except `id` and `transcript`. `emLevel: null` means no
visit code is expected. Prefer a case that tests something none of the existing
20 do — coverage of distinct failure modes beats volume.
