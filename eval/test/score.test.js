import test from "node:test";
import assert from "node:assert/strict";

import { scoreEncounter, aggregate, isEmCode, normalizeCode } from "../score.mjs";

const transcript =
  "Sore throat for three days. No cough. Temperature one hundred and one. " +
  "I am going to run a rapid strep test today. You are also due for your flu shot.";

const fixture = {
  id: "test-case",
  tests: "scorer unit test",
  transcript,
  expected: {
    diagnoses: ["J02.0", "Z23"],
    diagnosisAlternates: { "J02.0": ["J02.9"] },
    procedures: ["87880", "90471"],
    emLevel: "99213",
    links: { "87880": ["J02.0"], "90471": ["Z23"] },
    mustNotCode: ["J45.909"],
    groundingPhrases: ["three days", "no cough"],
  },
};

// Replace a suggestion by code. Index-based mutation is fragile here: once a
// test filters the list, positions shift and the wrong entry gets overwritten.
function replaceCode(answer, code, replacement) {
  const i = answer.suggestions.findIndex((s) => s.code === code);
  assert.notEqual(i, -1, `fixture should contain ${code}`);
  answer.suggestions[i] = replacement;
  return answer;
}

const sug = (code, codeType, supportingDiagnoses = []) => ({
  code,
  codeType,
  description: code,
  confidence: "high",
  rationale: "",
  supportingDiagnoses,
});

function perfectAnswer() {
  return {
    facts: { medicalNecessityLanguage: ["Sore throat for three days.", "No cough."] },
    suggestions: [
      sug("J02.0", "ICD-10"),
      sug("Z23", "ICD-10"),
      sug("87880", "CPT", ["J02.0"]),
      sug("90471", "CPT", ["Z23"]),
      sug("99213", "CPT", ["J02.0"]),
    ],
  };
}

test("a perfect answer scores clean across every dimension", () => {
  const r = scoreEncounter(fixture, perfectAnswer());

  assert.equal(r.diagnoses.hit, 2);
  assert.equal(r.procedures.hit, 2);
  assert.equal(r.em.verdict, "correct");
  assert.equal(r.linkage.correct, 2);
  assert.equal(r.forbidden.length, 0);
  assert.equal(r.extraCodes.length, 0);
  assert.equal(r.grounding.verified, 2);
  assert.equal(r.grounding.phrasesFound, 2);
});

test("an accepted alternate diagnosis counts as a hit", () => {
  const a = perfectAnswer();
  replaceCode(a, "J02.0", sug("J02.9", "ICD-10")); // accepted alternate
  replaceCode(a, "87880", sug("87880", "CPT", ["J02.9"]));
  const r = scoreEncounter(fixture, a);
  assert.equal(r.diagnoses.hit, 2);
  assert.equal(r.linkage.correct, 2, "linkage should follow the alternate too");
});

test("code formatting differences do not count as misses", () => {
  const a = perfectAnswer();
  replaceCode(a, "J02.0", sug(" j020 ", "ICD-10"));
  replaceCode(a, "87880", sug("87880", "CPT", ["j02.0"]));
  const r = scoreEncounter(fixture, a);
  assert.equal(r.diagnoses.hit, 2);
  assert.equal(r.linkage.correct, 2);
});

test("a missed diagnosis is reported by code, not just counted", () => {
  const a = perfectAnswer();
  a.suggestions = a.suggestions.filter((s) => s.code !== "Z23");
  const r = scoreEncounter(fixture, a);
  assert.equal(r.diagnoses.hit, 1);
  assert.deepEqual(r.diagnoses.missed, ["Z23"]);
});

test("E/M one level high is off-by-one, and the direction is recorded", () => {
  const a = perfectAnswer();
  replaceCode(a, "99213", sug("99214", "CPT"));
  const r = scoreEncounter(fixture, a);
  assert.equal(r.em.verdict, "off-by-one");
  assert.equal(r.em.distance, 1, "positive distance means coded higher than the key");
});

test("E/M two levels off is wrong, not off-by-one", () => {
  const a = perfectAnswer();
  replaceCode(a, "99213", sug("99215", "CPT"));
  const r = scoreEncounter(fixture, a);
  assert.equal(r.em.verdict, "wrong");
  assert.equal(r.em.distance, 2);
});

test("a missing E/M code is distinguished from a wrong one", () => {
  const a = perfectAnswer();
  a.suggestions = a.suggestions.filter((s) => !isEmCode(s.code));
  const r = scoreEncounter(fixture, a);
  assert.equal(r.em.verdict, "missing");
});

test("an E/M code where the key expects none is flagged as unexpected", () => {
  const noEm = { ...fixture, expected: { ...fixture.expected, emLevel: null, links: {} } };
  const r = scoreEncounter(noEm, perfectAnswer());
  assert.equal(r.em.verdict, "unexpected");
});

test("the wrong E/M level is not double-counted as a missing procedure", () => {
  const a = perfectAnswer();
  replaceCode(a, "99213", sug("99214", "CPT"));
  const r = scoreEncounter(fixture, a);
  assert.equal(r.procedures.hit, 2, "87880 and 90471 are still both present");
  assert.equal(r.extraCodes.length, 0, "the E/M miss is scored on the ladder only");
});

test("a forbidden code is caught", () => {
  const a = perfectAnswer();
  a.suggestions.push(sug("J45.909", "ICD-10"));
  const r = scoreEncounter(fixture, a);
  assert.deepEqual(r.forbidden, ["J45.909"]);
});

test("a code outside the key is reported as extra, not as an error", () => {
  const a = perfectAnswer();
  a.suggestions.push(sug("R50.9", "ICD-10"));
  const r = scoreEncounter(fixture, a);
  assert.deepEqual(r.extraCodes, ["R50.9"]);
  assert.equal(r.forbidden.length, 0);
});

test("mislinked service lines are caught even when every code is right", () => {
  const a = perfectAnswer();
  // The exact regression P0 fixed: vaccine admin pointed at the sore throat.
  replaceCode(a, "90471", sug("90471", "CPT", ["J02.0"]));
  const r = scoreEncounter(fixture, a);

  assert.equal(r.diagnoses.hit, 2, "codes are all correct...");
  assert.equal(r.procedures.hit, 2);
  assert.equal(r.linkage.correct, 1, "...but the linkage is not");
  assert.equal(r.linkage.wrong[0].cpt, "90471");
});

test("an unlinked service line is caught", () => {
  const a = perfectAnswer();
  replaceCode(a, "87880", sug("87880", "CPT", []));
  const r = scoreEncounter(fixture, a);
  assert.equal(r.linkage.correct, 1);
  assert.equal(r.linkage.wrong[0].got, "(none)");
});

test("a fabricated quote is not counted as grounded", () => {
  const a = perfectAnswer();
  a.facts.medicalNecessityLanguage = ["Patient was admitted overnight for observation."];
  const r = scoreEncounter(fixture, a);
  assert.equal(r.grounding.verified, 0);
  assert.equal(r.grounding.unsupported.length, 1);
});

test("a claim that cannot be built is reported rather than thrown", () => {
  const a = perfectAnswer();
  for (let i = 0; i < 13; i++) a.suggestions.push(sug(`A${String(i).padStart(2, "0")}`, "ICD-10"));
  const r = scoreEncounter(fixture, a);
  assert.ok(r.linkage.claimError, "the 12-diagnosis cap should surface as a claim error");
  assert.equal(r.linkage.correct, 0);
});

test("empty output scores zero without throwing", () => {
  const r = scoreEncounter(fixture, { facts: {}, suggestions: [] });
  assert.equal(r.diagnoses.hit, 0);
  assert.equal(r.procedures.hit, 0);
  assert.equal(r.em.verdict, "missing");
  assert.equal(r.grounding.quotes, 0);
});

// ---- aggregation ----

test("aggregate reports rates, and null where nothing was expected", () => {
  const perfect = scoreEncounter(fixture, perfectAnswer());

  const bad = perfectAnswer();
  replaceCode(bad, "90471", sug("90471", "CPT", ["J02.0"]));
  bad.suggestions = bad.suggestions.filter((s) => s.code !== "Z23");
  const imperfect = scoreEncounter(fixture, bad);

  const agg = aggregate([perfect, imperfect]);

  assert.equal(agg.encounters, 2);
  assert.equal(agg.diagnosisRecall, 3 / 4, "2 of 2 plus 1 of 2");
  assert.equal(agg.emExact, 1);
  assert.equal(agg.linkageAccuracy, 3 / 4);
  assert.equal(agg.forbiddenCodeCount, 0);
});

test("aggregate does not divide by zero when a dimension is untested", () => {
  const noLinks = { ...fixture, expected: { ...fixture.expected, links: {}, groundingPhrases: [] } };
  const agg = aggregate([scoreEncounter(noLinks, perfectAnswer())]);
  assert.equal(agg.linkageAccuracy, null);
  assert.equal(agg.necessityPhraseRecall, null);
});

test("normalizeCode and isEmCode behave as the rest of the scorer assumes", () => {
  assert.equal(normalizeCode(" j02.9 "), "J029");
  assert.equal(normalizeCode(null), "");
  assert.equal(isEmCode("99213"), true);
  assert.equal(isEmCode("87880"), false);
});
