import test from "node:test";
import assert from "node:assert/strict";

import { submitClaim, SubmissionError } from "../src/pipeline/submitClaim.js";

const validClaim = {
  payer: { name: "Sample Payer Insurance" },
  diagnoses: [{ pointer: "A", code: "J02.9", description: "Acute pharyngitis" }],
  serviceLines: [{ code: "87880", description: "Strep A rapid test", diagnosisPointers: "A", units: 1 }],
};

test("a valid claim gets a simulated confirmation", () => {
  const result = submitClaim(validClaim);
  assert.equal(result.simulated, true);
  assert.equal(result.status, "accepted");
  assert.match(result.confirmationNumber, /^MOCK-[0-9A-F]{8}$/);
  assert.equal(result.payerName, "Sample Payer Insurance");
});

test("two submissions of the same claim get different confirmation numbers", () => {
  const first = submitClaim(validClaim);
  const second = submitClaim(validClaim);
  assert.notEqual(first.confirmationNumber, second.confirmationNumber);
});

test("no claim is rejected", () => {
  assert.throws(() => submitClaim(undefined), SubmissionError);
});

test("a claim with no diagnoses is rejected", () => {
  assert.throws(() => submitClaim({ ...validClaim, diagnoses: [] }), SubmissionError);
});

test("a claim with no service lines is rejected", () => {
  assert.throws(() => submitClaim({ ...validClaim, serviceLines: [] }), SubmissionError);
});
