import test from "node:test";
import assert from "node:assert/strict";

import { populateClaim } from "../src/pipeline/populateClaim.js";
import { buildCorrectedClaim, CorrectedClaimError } from "../src/pipeline/buildCorrectedClaim.js";

const facts = { chiefComplaint: "Sore throat", medicalNecessityLanguage: [] };
const codes = [
  { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis, unspecified", supportingDiagnoses: [] },
  { code: "87880", codeType: "CPT", description: "Strep A rapid test", supportingDiagnoses: ["J02.9"] },
  { code: "99213", codeType: "CPT", description: "Office visit", supportingDiagnoses: ["J02.9"] },
];

test("a suggested code replaces the line it names", () => {
  const claim = populateClaim(facts, codes);
  const corrected = buildCorrectedClaim(claim, [
    { currentCode: "87880", suggestedCode: "87651", reason: "Wrong strep assay code" },
  ]);

  const codesOut = corrected.serviceLines.map((l) => l.code);
  assert.deepEqual(codesOut, ["87651", "99213"]);
  // Untouched fields on the changed line carry over -- only the code moves.
  const changed = corrected.serviceLines.find((l) => l.code === "87651");
  assert.equal(changed.diagnosisPointers, "A");
});

test("an empty suggestedCode drops the line instead of replacing it", () => {
  const claim = populateClaim(facts, codes);
  const corrected = buildCorrectedClaim(claim, [{ currentCode: "87880", suggestedCode: "", reason: "Not billable" }]);

  assert.deepEqual(
    corrected.serviceLines.map((l) => l.code),
    ["99213"]
  );
});

test("lines with no matching change pass through unmodified", () => {
  const claim = populateClaim(facts, codes);
  const corrected = buildCorrectedClaim(claim, [{ currentCode: "87880", suggestedCode: "87651" }]);

  const untouched = corrected.serviceLines.find((l) => l.code === "99213");
  assert.deepEqual(untouched, claim.serviceLines.find((l) => l.code === "99213"));
});

test("a change naming a code the claim doesn't carry is rejected, not silently dropped", () => {
  const claim = populateClaim(facts, codes);
  assert.throws(
    () => buildCorrectedClaim(claim, [{ currentCode: "99999", suggestedCode: "12345" }]),
    (err) => err instanceof CorrectedClaimError && /99999/.test(err.message)
  );
});

test("dropping every line is rejected -- a claim needs at least one", () => {
  const claim = populateClaim(facts, [codes[0], codes[1]]); // one CPT line only
  assert.throws(
    () => buildCorrectedClaim(claim, [{ currentCode: "87880", suggestedCode: "" }]),
    CorrectedClaimError
  );
});

// A "diagnosis is inconsistent with the procedure" denial (CO-11) can be
// fixed on either side of the link -- this is what real Claude-drafted
// appeals actually suggested against a live denial (see the commit this
// test landed in), not just a hypothetical.
test("a suggested code also matches against diagnoses, not just service lines", () => {
  const claim = populateClaim(facts, codes);
  const corrected = buildCorrectedClaim(claim, [
    { currentCode: "J02.9", suggestedCode: "J06.9", reason: "Better matches the documented symptoms" },
  ]);

  assert.deepEqual(
    corrected.diagnoses.map((d) => d.code),
    ["J06.9"]
  );
  // The pointer letter stays put -- service lines still point at the same
  // position, just a different code now sits there.
  assert.equal(corrected.diagnoses[0].pointer, "A");
  assert.deepEqual(corrected.serviceLines, claim.serviceLines);
});

test("an empty suggestedCode drops a diagnosis instead of replacing it", () => {
  const twoDiagnosisCodes = [
    ...codes,
    { code: "R09.81", codeType: "ICD-10", description: "Nasal congestion", supportingDiagnoses: [] },
  ];
  const claim = populateClaim(facts, twoDiagnosisCodes);
  const corrected = buildCorrectedClaim(claim, [{ currentCode: "R09.81", suggestedCode: "" }]);

  assert.deepEqual(
    corrected.diagnoses.map((d) => d.code),
    ["J02.9"]
  );
});

test("dropping every diagnosis is rejected -- a claim needs at least one", () => {
  const claim = populateClaim(facts, codes);
  assert.throws(() => buildCorrectedClaim(claim, [{ currentCode: "J02.9", suggestedCode: "" }]), CorrectedClaimError);
});

test("a procedure change and a diagnosis change apply together in one pass", () => {
  const claim = populateClaim(facts, codes);
  const corrected = buildCorrectedClaim(claim, [
    { currentCode: "87880", suggestedCode: "87651" },
    { currentCode: "J02.9", suggestedCode: "J06.9" },
  ]);

  assert.deepEqual(
    corrected.serviceLines.map((l) => l.code).sort(),
    ["87651", "99213"]
  );
  assert.deepEqual(
    corrected.diagnoses.map((d) => d.code),
    ["J06.9"]
  );
});

test("no changes given is rejected -- resubmitting unchanged wastes the filing window", () => {
  const claim = populateClaim(facts, codes);
  assert.throws(() => buildCorrectedClaim(claim, []), CorrectedClaimError);
  assert.throws(() => buildCorrectedClaim(claim, undefined), CorrectedClaimError);
});

test("everything besides serviceLines carries over untouched", () => {
  const claim = populateClaim(facts, codes);
  const corrected = buildCorrectedClaim(claim, [{ currentCode: "87880", suggestedCode: "87651" }]);
  assert.equal(corrected.patient, claim.patient);
  assert.equal(corrected.provider, claim.provider);
  assert.deepEqual(corrected.diagnoses, claim.diagnoses);
});
