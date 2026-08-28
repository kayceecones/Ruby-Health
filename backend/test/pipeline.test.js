import test from "node:test";
import assert from "node:assert/strict";

import { populateClaim, ClaimError } from "../src/pipeline/populateClaim.js";
import { verifyQuote, verifyNecessityQuotes, GROUNDING } from "../src/pipeline/verifyQuotes.js";

const facts = {
  chiefComplaint: "Sore throat",
  medicalNecessityLanguage: ["Symptoms have persisted for three days."],
};

// A sore throat plus an unrelated immunization: the case where pointing every
// service line at the first diagnosis produces a denial.
const twoProblemCodes = [
  { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis, unspecified", supportingDiagnoses: [] },
  { code: "Z23", codeType: "ICD-10", description: "Encounter for immunization", supportingDiagnoses: [] },
  { code: "87880", codeType: "CPT", description: "Strep A rapid test", supportingDiagnoses: ["J02.9"] },
  { code: "90471", codeType: "CPT", description: "Immunization administration", supportingDiagnoses: ["Z23"] },
];

test("each service line points at the diagnosis that justifies it", () => {
  const claim = populateClaim(facts, twoProblemCodes);

  const strep = claim.serviceLines.find((l) => l.code === "87880");
  const shot = claim.serviceLines.find((l) => l.code === "90471");

  assert.equal(strep.diagnosisPointers, "A", "strep test should point at the pharyngitis");
  assert.equal(shot.diagnosisPointers, "B", "immunization admin should point at the immunization");
  assert.equal(claim.warnings.length, 0);
});

test("a service line supported by two diagnoses carries both pointers", () => {
  const claim = populateClaim(facts, [
    ...twoProblemCodes.slice(0, 2),
    { code: "99213", codeType: "CPT", description: "Office visit", supportingDiagnoses: ["J02.9", "Z23"] },
  ]);
  assert.equal(claim.serviceLines[0].diagnosisPointers, "AB");
});

test("codes match regardless of formatting", () => {
  const claim = populateClaim(facts, [
    { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
    { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: [" j029 "] },
  ]);
  assert.equal(claim.serviceLines[0].diagnosisPointers, "A");
});

test("a duplicated supporting diagnosis resolves to one pointer", () => {
  const claim = populateClaim(facts, [
    { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
    { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: ["J02.9", "J02.9"] },
  ]);
  assert.equal(claim.serviceLines[0].diagnosisPointers, "A");
});

test("an unlinked service line is flagged rather than silently pointed at A", () => {
  const claim = populateClaim(facts, [
    { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
    { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: [] },
  ]);

  assert.equal(claim.serviceLines[0].diagnosisPointers, "");
  assert.equal(claim.warnings.length, 1);
  assert.equal(claim.warnings[0].code, "UNLINKED_SERVICE_LINE");
  assert.equal(claim.warnings[0].line, "87880");
});

test("a supporting diagnosis that is not on the claim is flagged", () => {
  const claim = populateClaim(facts, [
    { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
    { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: ["E11.9"] },
  ]);

  assert.equal(claim.warnings.some((w) => w.code === "UNKNOWN_SUPPORTING_DIAGNOSIS"), true);
  assert.equal(claim.warnings.some((w) => w.code === "UNLINKED_SERVICE_LINE"), true);
});

test("pointers past the fourth are dropped and reported", () => {
  const diagnoses = ["A00", "B00", "C00", "D00", "E00"].map((code) => ({
    code,
    codeType: "ICD-10",
    description: code,
    supportingDiagnoses: [],
  }));
  const claim = populateClaim(facts, [
    ...diagnoses,
    { code: "99213", codeType: "CPT", description: "Office visit", supportingDiagnoses: ["A00", "B00", "C00", "D00", "E00"] },
  ]);

  assert.equal(claim.serviceLines[0].diagnosisPointers, "ABCD");
  assert.equal(claim.warnings.some((w) => w.code === "POINTERS_TRUNCATED"), true);
});

test("more than twelve diagnoses is rejected instead of running past Z", () => {
  const thirteen = Array.from({ length: 13 }, (_, i) => ({
    code: `A${String(i).padStart(2, "0")}`,
    codeType: "ICD-10",
    description: "Diagnosis",
    supportingDiagnoses: [],
  }));

  assert.throws(() => populateClaim(facts, thirteen), ClaimError);
});

test("exactly twelve diagnoses is allowed and ends at pointer L", () => {
  const twelve = Array.from({ length: 12 }, (_, i) => ({
    code: `A${String(i).padStart(2, "0")}`,
    codeType: "ICD-10",
    description: "Diagnosis",
    supportingDiagnoses: [],
  }));
  const claim = populateClaim(facts, twelve);
  assert.equal(claim.diagnoses.at(-1).pointer, "L");
});

// ---- quote grounding ----

const transcript =
  "Patient reports a sore throat that started three days ago. No cough. " +
  "Temperature is one hundred and one. I am going to run a rapid strep test today.";

test("a verbatim quote verifies", () => {
  const r = verifyQuote("I am going to run a rapid strep test today.", transcript);
  assert.equal(r.status, GROUNDING.VERIFIED);
});

test("punctuation and casing differences still verify", () => {
  const r = verifyQuote("no cough", transcript);
  assert.equal(r.status, GROUNDING.VERIFIED);
});

test("a reworded quote is marked paraphrased, not passed off as a quote", () => {
  const r = verifyQuote("Sore throat started three days ago, reports patient, with no cough.", transcript);
  assert.equal(r.status, GROUNDING.PARAPHRASED);
});

test("a statement the transcript does not support is unsupported", () => {
  const r = verifyQuote("Patient has a documented history of rheumatic fever requiring prophylaxis.", transcript);
  assert.equal(r.status, GROUNDING.UNSUPPORTED);
});

test("a short quote must match exactly rather than pass on word overlap", () => {
  const r = verifyQuote("cough test", transcript);
  assert.equal(r.status, GROUNDING.UNSUPPORTED);
});

test("grounding results line up with the quotes they describe", () => {
  const results = verifyNecessityQuotes(
    { medicalNecessityLanguage: ["No cough.", "Patient was admitted overnight for observation."] },
    transcript
  );

  assert.equal(results.length, 2);
  assert.equal(results[0].quote, "No cough.");
  assert.equal(results[0].status, GROUNDING.VERIFIED);
  assert.equal(results[1].status, GROUNDING.UNSUPPORTED);
});

test("missing necessity language is handled without throwing", () => {
  assert.deepEqual(verifyNecessityQuotes({}, transcript), []);
});
