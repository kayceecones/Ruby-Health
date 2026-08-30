import test from "node:test";
import assert from "node:assert/strict";

import { annotateValidation, unrecognisedCodes, VALIDATION } from "../src/pipeline/validateCodes.js";

const sug = (code, codeType) => ({ code, codeType, description: code, confidence: "high", rationale: "", supportingDiagnoses: [] });

function index(codes, coversTypes = ["ICD-10"]) {
  return {
    byKey: new Map(codes.map((c) => [c.replace(/[^A-Z0-9]/gi, "").toUpperCase(), { code: c }])),
    coversTypes: new Set(coversTypes),
    source: "test-set",
    size: codes.length,
  };
}

test("a code in the reference set is marked known", () => {
  const out = annotateValidation([sug("J02.9", "ICD-10")], index(["J02.9"]));
  assert.equal(out[0].validation.status, VALIDATION.KNOWN);
  assert.equal(out[0].validation.source, "test-set");
});

test("formatting differences still match", () => {
  const out = annotateValidation([sug("j029", "ICD-10")], index(["J02.9"]));
  assert.equal(out[0].validation.status, VALIDATION.KNOWN);
});

test("a code absent from the set is flagged but never removed", () => {
  const input = [sug("J02.9", "ICD-10"), sug("J99.999", "ICD-10")];
  const out = annotateValidation(input, index(["J02.9"]));

  assert.equal(out.length, 2, "nothing is dropped -- validation is warning-level");
  assert.equal(out[1].validation.status, VALIDATION.UNRECOGNISED);
  assert.deepEqual(unrecognisedCodes(out), ["J99.999"]);
});

test("a code system the reference set does not cover is unchecked, not unrecognised", () => {
  // The live set is ICD-10 only. Reporting every CPT code as unrecognised
  // would be a false alarm on every procedure on every claim.
  const out = annotateValidation([sug("87880", "CPT")], index(["J02.9"], ["ICD-10"]));
  assert.equal(out[0].validation.status, VALIDATION.UNCHECKED);
  assert.deepEqual(unrecognisedCodes(out), []);
});

test("no reference set at all means unchecked, not failure", () => {
  for (const idx of [null, undefined, { byKey: new Map(), coversTypes: new Set() }]) {
    const out = annotateValidation([sug("J02.9", "ICD-10")], idx);
    assert.equal(out[0].validation.status, VALIDATION.UNCHECKED);
  }
});

test("the original suggestion fields survive annotation", () => {
  const out = annotateValidation([sug("J02.9", "ICD-10")], index(["J02.9"]));
  assert.equal(out[0].code, "J02.9");
  assert.equal(out[0].codeType, "ICD-10");
  assert.equal(out[0].confidence, "high");
  assert.ok(Array.isArray(out[0].supportingDiagnoses));
});

test("an empty or malformed suggestion list does not throw", () => {
  assert.deepEqual(annotateValidation([], index(["J02.9"])), []);
  assert.deepEqual(annotateValidation(null, index(["J02.9"])), []);
});
