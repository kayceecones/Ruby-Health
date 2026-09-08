import test from "node:test";
import assert from "node:assert/strict";

import {
  loadAdjustmentCodes,
  normalizeReasonCode,
  describeCarc,
  describeRarc,
  describeGroupCode,
} from "../loadAdjustmentCodes.mjs";

const codes = await loadAdjustmentCodes();

test("the committed reason-code file actually loads", () => {
  // Unlike reference/codes/, this one ships with the repo -- if it stops
  // loading, every denial explanation silently degrades to raw codes.
  assert.equal(codes.loaded, true);
  assert.ok(codes.carc.size > 0);
  assert.ok(codes.rarc.size > 0);
});

test("a leading zero does not turn a known code into an unknown one", () => {
  assert.equal(normalizeReasonCode("001"), "1");
  assert.equal(normalizeReasonCode("1"), "1");
  assert.equal(normalizeReasonCode("b7"), "B7");
  assert.equal(normalizeReasonCode("  45 "), "45");
  assert.equal(normalizeReasonCode(null), "");

  assert.equal(describeCarc(codes, "001").known, true);
  assert.equal(describeCarc(codes, "1").code, "1");
});

test("CARC lookup carries both the payer's meaning and Ruby's category", () => {
  const necessity = describeCarc(codes, "50");
  assert.equal(necessity.known, true);
  assert.match(necessity.description, /medical necessity/i);
  assert.equal(necessity.category, "documentation");
  assert.equal(necessity.kind, "CARC");

  const deductible = describeCarc(codes, "1");
  assert.equal(deductible.category, "patient_responsibility");

  const duplicate = describeCarc(codes, "18");
  assert.equal(duplicate.category, "duplicate");
});

test("an unrecognised code is reported raw, never guessed at", () => {
  const unknown = describeCarc(codes, "9999");
  assert.equal(unknown.known, false);
  assert.equal(unknown.category, "unknown");
  assert.equal(unknown.description, "");
  // The code itself still survives, so a human can go look it up.
  assert.equal(unknown.code, "9999");
});

test("RARC lookup works the same way", () => {
  const npi = describeRarc(codes, "N290");
  assert.equal(npi.known, true);
  assert.equal(npi.kind, "RARC");
  assert.match(npi.description, /rendering provider/i);
  assert.equal(describeRarc(codes, "N9999").known, false);
});

test("group codes say whether an amount may be billed to the patient", () => {
  // Getting this backwards is a real problem in both directions: billing a
  // contractual write-off violates the payer contract, and writing off
  // patient responsibility is revenue nobody ever collects.
  assert.equal(describeGroupCode(codes, "PR").billable, true);
  assert.equal(describeGroupCode(codes, "CO").billable, false);
  assert.equal(describeGroupCode(codes, "OA").billable, false);
  assert.equal(describeGroupCode(codes, "co").known, true);
  assert.equal(describeGroupCode(codes, "ZZ").known, false);
});

test("a missing file degrades to empty lookups instead of throwing", async () => {
  const missing = await loadAdjustmentCodes("/nonexistent/adjustment-codes.json");
  assert.equal(missing.loaded, false);
  assert.equal(missing.carc.size, 0);
  assert.equal(describeCarc(missing, "50").known, false);
});
