import test from "node:test";
import assert from "node:assert/strict";

import { populateClaim } from "../src/pipeline/populateClaim.js";
import { buildStediClaim, StediMappingError, STEDI_TEST_PAYER_ID } from "../src/pipeline/buildStediClaim.js";

const facts = { chiefComplaint: "Sore throat", medicalNecessityLanguage: [] };

const testProviderProfile = {
  name: "Test Practice",
  npi: "1234567893",
  address: { address1: "1 Test St", city: "Testville", state: "CA", postalCode: "900010000" },
};

const codes = [
  { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis, unspecified", supportingDiagnoses: [] },
  { code: "Z23", codeType: "ICD-10", description: "Encounter for immunization", supportingDiagnoses: [] },
  { code: "87880", codeType: "CPT", description: "Strep A rapid test", supportingDiagnoses: ["J02.9"] },
  { code: "90471", codeType: "CPT", description: "Immunization administration", supportingDiagnoses: ["Z23"] },
];

test("defaults to Stedi's Test Payer when no payer is configured", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  assert.equal(stediClaim.tradingPartnerServiceId, STEDI_TEST_PAYER_ID);
  assert.equal(stediClaim.usageIndicator, "T");
});

test("ICD-10 decimal points are stripped for Stedi", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  const principal = stediClaim.claimInformation.healthCareCodeInformation[0];
  assert.equal(principal.diagnosisCode, "J029");
  assert.equal(principal.diagnosisTypeCode, "ABK");
});

test("only the first diagnosis is marked principal (ABK); rest are ABF", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  const types = stediClaim.claimInformation.healthCareCodeInformation.map((d) => d.diagnosisTypeCode);
  assert.deepEqual(types, ["ABK", "ABF"]);
});

test("letter pointers resolve to 1-based integer pointers Stedi expects", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  const strep = stediClaim.claimInformation.serviceLines.find(
    (l) => l.professionalService.procedureCode === "87880"
  );
  const shot = stediClaim.claimInformation.serviceLines.find(
    (l) => l.professionalService.procedureCode === "90471"
  );
  assert.deepEqual(strep.professionalService.compositeDiagnosisCodePointers.diagnosisCodePointers, ["1"]);
  assert.deepEqual(shot.professionalService.compositeDiagnosisCodePointers.diagnosisCodePointers, ["2"]);
});

test("every service line carries a serviceDate -- Stedi rejects lines missing one", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  const expected = claim.dateOfService.replace(/-/g, "");
  for (const line of stediClaim.claimInformation.serviceLines) {
    assert.equal(line.serviceDate, expected);
    assert.equal(line.professionalService.serviceDate, undefined); // Stedi rejects it here as an unknown field
  }
});

test("claimInformation carries a signatureIndicator -- Stedi requires one", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim);
  assert.equal(stediClaim.claimInformation.signatureIndicator, "Y");
});

test("an unlinked service line falls back to the principal diagnosis so it still submits", () => {
  const claim = populateClaim(
    facts,
    [
      { code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis", supportingDiagnoses: [] },
      { code: "87880", codeType: "CPT", description: "Strep test", supportingDiagnoses: [] },
    ],
    testProviderProfile
  );
  assert.equal(claim.warnings.length, 1); // populateClaim already flagged this

  const stediClaim = buildStediClaim(claim);
  const line = stediClaim.claimInformation.serviceLines[0];
  assert.deepEqual(line.professionalService.compositeDiagnosisCodePointers.diagnosisCodePointers, ["1"]);
});

test("claim charge amount is the per-line rate times service line count", () => {
  const claim = populateClaim(facts, codes);
  const stediClaim = buildStediClaim(claim, { chargeAmountPerLine: 50 });
  assert.equal(stediClaim.claimInformation.claimChargeAmount, "100.00"); // 2 CPT lines * $50
});

test("rejects a claim with no diagnoses", () => {
  assert.throws(() => buildStediClaim({ diagnoses: [], serviceLines: [{ code: "1" }] }), StediMappingError);
});

test("rejects a claim with no service lines", () => {
  assert.throws(
    () => buildStediClaim({ diagnoses: [{ pointer: "A", code: "J02.9" }], serviceLines: [] }),
    StediMappingError
  );
});
