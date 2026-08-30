// Scoring for the accuracy evaluation.
//
// Pure functions over (expected, actual). No network, no model, no clock --
// the same inputs always produce the same scorecard, so a change in the number
// means a change in the pipeline rather than a change in the weather.

import { verifyNecessityQuotes, GROUNDING } from "../backend/src/pipeline/verifyQuotes.js";
import { populateClaim, ClaimError } from "../backend/src/pipeline/populateClaim.js";

// Codes are compared on bare alphanumerics so "J02.9", "j029" and " J02.9 "
// are the same code. This mirrors populateClaim's own matching.
export function normalizeCode(code) {
  return String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function codeSet(codes) {
  return new Set(codes.map(normalizeCode).filter(Boolean));
}

// Office-visit evaluation and management codes, lowest to highest. Used to
// measure how far off a level is, not just whether it matched.
const EM_LADDER = ["99211", "99212", "99213", "99214", "99215"];

export function isEmCode(code) {
  return EM_LADDER.includes(normalizeCode(code));
}

/**
 * Did the suggestion list satisfy one expected code?
 * An expected code is satisfied by itself or by any of its accepted alternates
 * -- real coders disagree at the margins, and an eval that punishes a
 * defensible alternate measures conformity rather than accuracy.
 */
function matchedExpected(expectedCode, alternates, actualSet) {
  const candidates = [expectedCode, ...(alternates[expectedCode] || [])];
  return candidates.some((c) => actualSet.has(normalizeCode(c)));
}

/**
 * Score a single encounter.
 *
 * @param {object} fixture   the encounter fixture (transcript + expected)
 * @param {object} actual    { facts, suggestions } as returned by the pipeline
 */
export function scoreEncounter(fixture, actual) {
  const expected = fixture.expected || {};
  const alternates = expected.diagnosisAlternates || {};
  const suggestions = Array.isArray(actual?.suggestions) ? actual.suggestions : [];

  const actualDiagnoses = suggestions.filter((s) => s.codeType === "ICD-10");
  const actualProcedures = suggestions.filter((s) => s.codeType === "CPT");

  const actualDxSet = codeSet(actualDiagnoses.map((s) => s.code));
  // E/M codes are scored on their own ladder, so they are excluded from the
  // procedure recall figure -- otherwise a wrong visit level would be counted
  // twice, once as a miss and once as a spurious code.
  const actualProcSet = codeSet(actualProcedures.filter((s) => !isEmCode(s.code)).map((s) => s.code));

  // ---- diagnosis recall ----
  const expectedDx = expected.diagnoses || [];
  const dxHits = expectedDx.filter((c) => matchedExpected(c, alternates, actualDxSet));
  const dxMissed = expectedDx.filter((c) => !matchedExpected(c, alternates, actualDxSet));

  // ---- procedure recall (excluding the E/M code) ----
  const expectedProc = (expected.procedures || []).filter((c) => !isEmCode(c));
  const procHits = expectedProc.filter((c) => actualProcSet.has(normalizeCode(c)));
  const procMissed = expectedProc.filter((c) => !actualProcSet.has(normalizeCode(c)));

  // ---- E/M level ----
  const actualEm = actualProcedures.map((s) => s.code).find((c) => isEmCode(c)) || null;
  const expectedEm = expected.emLevel || null;
  let em;
  if (!expectedEm && !actualEm) em = { verdict: "correct", distance: 0, expected: null, actual: null };
  else if (expectedEm && !actualEm) em = { verdict: "missing", distance: null, expected: expectedEm, actual: null };
  else if (!expectedEm && actualEm) em = { verdict: "unexpected", distance: null, expected: null, actual: actualEm };
  else {
    const distance = EM_LADDER.indexOf(normalizeCode(actualEm)) - EM_LADDER.indexOf(normalizeCode(expectedEm));
    em = {
      verdict: distance === 0 ? "correct" : Math.abs(distance) === 1 ? "off-by-one" : "wrong",
      // Positive means the system coded higher than the key, which is the
      // direction that reads as upcoding on an audit.
      distance,
      expected: expectedEm,
      actual: actualEm,
    };
  }

  // ---- codes that should never appear ----
  const allActual = new Set([...actualDxSet, ...codeSet(actualProcedures.map((s) => s.code))]);
  const forbiddenHits = (expected.mustNotCode || []).filter((c) => allActual.has(normalizeCode(c)));

  // ---- codes beyond the key (informational, not an error) ----
  const acceptedDx = new Set();
  for (const c of expectedDx) {
    acceptedDx.add(normalizeCode(c));
    for (const alt of alternates[c] || []) acceptedDx.add(normalizeCode(alt));
  }
  const acceptedProc = new Set((expected.procedures || []).map(normalizeCode));
  if (expectedEm) acceptedProc.add(normalizeCode(expectedEm));
  const extraCodes = [
    ...actualDiagnoses.map((s) => s.code).filter((c) => !acceptedDx.has(normalizeCode(c))),
    ...actualProcedures
      .map((s) => s.code)
      .filter((c) => !isEmCode(c) && !acceptedProc.has(normalizeCode(c))),
  ];

  // ---- quote grounding ----
  const grounding = verifyNecessityQuotes(actual?.facts || {}, fixture.transcript || "");
  const groundedCount = grounding.filter((g) => g.status === GROUNDING.VERIFIED).length;
  const ungrounded = grounding.filter((g) => g.status === GROUNDING.UNSUPPORTED);

  // Phrases the key says a competent extraction should have captured somewhere
  // in its necessity language.
  const necessityText = (actual?.facts?.medicalNecessityLanguage || []).join(" ").toLowerCase();
  const expectedPhrases = expected.groundingPhrases || [];
  const phraseHits = expectedPhrases.filter((p) => necessityText.includes(String(p).toLowerCase()));

  // ---- diagnosis pointer linkage, through the real claim builder ----
  const linkage = scoreLinkage(expected.links || {}, actual, alternates);

  return {
    id: fixture.id,
    tests: fixture.tests,
    diagnoses: { expected: expectedDx.length, hit: dxHits.length, missed: dxMissed },
    procedures: { expected: expectedProc.length, hit: procHits.length, missed: procMissed },
    em,
    forbidden: forbiddenHits,
    extraCodes,
    grounding: {
      quotes: grounding.length,
      verified: groundedCount,
      unsupported: ungrounded.map((g) => g.quote),
      expectedPhrases: expectedPhrases.length,
      phrasesFound: phraseHits.length,
    },
    linkage,
  };
}

/**
 * Build the claim the way the app does, then check each service line points at
 * the diagnoses the answer key says justify it. This exercises the real
 * populateClaim, so a regression in pointer assignment shows up here.
 */
function scoreLinkage(expectedLinks, actual, alternates = {}) {
  const expectedPairs = Object.entries(expectedLinks).filter(([cpt]) => !isEmCode(cpt));
  if (expectedPairs.length === 0) {
    return { expected: 0, correct: 0, wrong: [], claimError: null };
  }

  let claim;
  try {
    claim = populateClaim(actual?.facts || {}, actual?.suggestions || []);
  } catch (err) {
    return {
      expected: expectedPairs.length,
      correct: 0,
      wrong: [],
      claimError: err instanceof ClaimError ? err.message : String(err),
    };
  }

  const pointerToCode = new Map(claim.diagnoses.map((d) => [d.pointer, normalizeCode(d.code)]));
  const lineByCode = new Map(claim.serviceLines.map((l) => [normalizeCode(l.code), l]));

  let correct = 0;
  const wrong = [];
  for (const [cpt, wantDx] of expectedPairs) {
    const line = lineByCode.get(normalizeCode(cpt));
    if (!line) {
      wrong.push({ cpt, reason: "service line absent from claim" });
      continue;
    }
    const gotDx = new Set(
      line.diagnosisPointers.split("").map((p) => pointerToCode.get(p)).filter(Boolean)
    );
    // A diagnosis may legitimately have been coded as an accepted alternate,
    // so the link is satisfied by the expected code or any of its alternates.
    const missing = wantDx.filter(
      (d) => ![d, ...(alternates[d] || [])].some((c) => gotDx.has(normalizeCode(c)))
    );
    if (missing.length === 0) correct += 1;
    else wrong.push({ cpt, reason: `not linked to ${missing.join(", ")}`, got: line.diagnosisPointers || "(none)" });
  }

  return { expected: expectedPairs.length, correct, wrong, claimError: null };
}

/** Roll individual encounter scores into a suite-level scorecard. */
export function aggregate(results) {
  const sum = (fn) => results.reduce((n, r) => n + fn(r), 0);

  const emScored = results.filter((r) => r.em.verdict !== "unexpected" || r.em.expected !== null);
  const emCorrect = results.filter((r) => r.em.verdict === "correct").length;
  const emOffByOne = results.filter((r) => r.em.verdict === "off-by-one").length;
  const emUpcoded = results.filter((r) => typeof r.em.distance === "number" && r.em.distance > 0).length;

  const dxExpected = sum((r) => r.diagnoses.expected);
  const procExpected = sum((r) => r.procedures.expected);
  const linkExpected = sum((r) => r.linkage.expected);
  const quotes = sum((r) => r.grounding.quotes);
  const phrases = sum((r) => r.grounding.expectedPhrases);

  const rate = (n, d) => (d === 0 ? null : n / d);

  return {
    encounters: results.length,
    diagnosisRecall: rate(sum((r) => r.diagnoses.hit), dxExpected),
    procedureRecall: rate(sum((r) => r.procedures.hit), procExpected),
    emExact: rate(emCorrect, emScored.length),
    emWithinOne: rate(emCorrect + emOffByOne, emScored.length),
    emUpcodedCount: emUpcoded,
    linkageAccuracy: rate(sum((r) => r.linkage.correct), linkExpected),
    groundingRate: rate(sum((r) => r.grounding.verified), quotes),
    necessityPhraseRecall: rate(sum((r) => r.grounding.phrasesFound), phrases),
    forbiddenCodeCount: sum((r) => r.forbidden.length),
    encountersWithForbiddenCode: results.filter((r) => r.forbidden.length > 0).length,
    extraCodeCount: sum((r) => r.extraCodes.length),
    claimErrors: results.filter((r) => r.linkage.claimError).length,
  };
}
