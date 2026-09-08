import test from "node:test";
import assert from "node:assert/strict";

import { parseRemittance, parseRemittanceClaim, money, RemittanceParseError } from "../src/pipeline/parseRemittance.js";

// Synthetic. Never put a real 835 in this repo -- see reference/README.md:
// a real remittance carries patient names, member IDs and diagnoses, and
// nothing here is encrypted, audited, or covered by a BAA.
const DENIED_CLAIM = {
  payerClaimControlNumber: "2026250012345",
  claimStatusCode: 4,
  totalClaimChargeAmount: "250.00",
  claimPaymentAmount: "0.00",
  serviceLines: [
    {
      procedureCode: "99213",
      lineItemChargeAmount: "150.00",
      lineItemProviderPaymentAmount: "0.00",
      adjustments: [{ adjustmentGroupCode: "CO", adjustmentReasonCode: "50", adjustmentAmount: "150.00" }],
      remarkCodes: ["N115"],
    },
    {
      procedureCode: "87880",
      lineItemChargeAmount: "100.00",
      lineItemProviderPaymentAmount: "0.00",
      adjustments: [{ adjustmentGroupCode: "CO", adjustmentReasonCode: "11", adjustmentAmount: "100.00" }],
    },
  ],
};

test("money survives the shapes payers actually send", () => {
  assert.equal(money("150.00"), 150);
  assert.equal(money(150), 150);
  assert.equal(money("$1,234.56"), 1234.56);
  assert.equal(money(null), 0);
  assert.equal(money("not a number"), 0);
  // Rounded to cents so later comparisons don't drift.
  assert.equal(money(0.1 + 0.2), 0.3);
});

test("parses a denied claim, its lines, and its adjustments", () => {
  const parsed = parseRemittanceClaim(DENIED_CLAIM);

  assert.equal(parsed.status, "denied");
  assert.equal(parsed.claimStatusCode, "4");
  assert.equal(parsed.totals.billed, 250);
  assert.equal(parsed.totals.paid, 0);
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0].procedureCode, "99213");
  assert.equal(parsed.lines[0].adjustments[0].reasonCode, "50");
  assert.equal(parsed.lines[0].adjustments[0].groupCode, "CO");
  assert.equal(parsed.lines[0].adjustments[0].amount, 150);
  assert.deepEqual(parsed.lines[0].remarkCodes, ["N115"]);
});

test("keeps the payer's claim control number -- a corrected claim is impossible without it", () => {
  assert.equal(parseRemittanceClaim(DENIED_CLAIM).payerClaimControlNumber, "2026250012345");
  assert.equal(parseRemittanceClaim({ ...DENIED_CLAIM, payerClaimControlNumber: undefined }).payerClaimControlNumber, null);
});

test("a claim paid entirely to the deductible is patient responsibility, not a denial", () => {
  // The provider received nothing, so inferring from the paid amount alone
  // would call this denied. It isn't -- it's billable to the patient.
  const parsed = parseRemittanceClaim({
    totalClaimChargeAmount: "120.00",
    claimPaymentAmount: "0.00",
    serviceLines: [
      {
        procedureCode: "99213",
        lineItemChargeAmount: "120.00",
        lineItemProviderPaymentAmount: "0.00",
        adjustments: [{ adjustmentGroupCode: "PR", adjustmentReasonCode: "1", adjustmentAmount: "120.00" }],
      },
    ],
  });

  assert.equal(parsed.status, "patient_responsibility");
  assert.equal(parsed.totals.patientResponsibility, 120);
});

test("infers partial payment when the payer sends no status code", () => {
  const parsed = parseRemittanceClaim({
    totalClaimChargeAmount: "200.00",
    claimPaymentAmount: "120.00",
    serviceLines: [],
  });
  assert.equal(parsed.status, "partially_paid");
});

test("accepts adjustments whether the reason pairs are flat or nested", () => {
  // One CAS segment carries up to six reason/amount pairs, and different
  // representations either flatten or nest them.
  const nested = parseRemittanceClaim({
    claimAdjustments: [
      {
        adjustmentGroupCode: "CO",
        adjustmentDetails: [
          { adjustmentReasonCode: "45", adjustmentAmount: "30.00" },
          { adjustmentReasonCode: "97", adjustmentAmount: "20.00" },
        ],
      },
    ],
  });

  assert.equal(nested.claimAdjustments.length, 2);
  assert.deepEqual(
    nested.claimAdjustments.map((a) => [a.groupCode, a.reasonCode, a.amount]),
    [["CO", "45", 30], ["CO", "97", 20]]
  );
});

test("derives claim totals from the lines when the claim level omits them", () => {
  const parsed = parseRemittanceClaim({
    serviceLines: [
      { procedureCode: "99213", lineItemChargeAmount: "150.00", lineItemProviderPaymentAmount: "100.00" },
      { procedureCode: "87880", lineItemChargeAmount: "50.00", lineItemProviderPaymentAmount: "25.00" },
    ],
  });
  assert.equal(parsed.totals.billed, 200);
  assert.equal(parsed.totals.paid, 125);
});

test("reads a multi-claim document and inherits payer and date from it", () => {
  const parsed = parseRemittance({
    payerName: "Sample Payer Insurance",
    productionDate: "2026-09-08",
    claims: [DENIED_CLAIM, { ...DENIED_CLAIM, payerClaimControlNumber: "2026250099999" }],
  });

  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].payerName, "Sample Payer Insurance");
  assert.equal(parsed[0].remittanceDate, "2026-09-08");
  assert.equal(parsed[1].payerClaimControlNumber, "2026250099999");
});

test("a bare single-claim payload is accepted rather than rejected", () => {
  const parsed = parseRemittance(DENIED_CLAIM);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].status, "denied");
});

test("a non-object payload is a parse error, not a crash later on", () => {
  assert.throws(() => parseRemittance(null), RemittanceParseError);
  assert.throws(() => parseRemittanceClaim("835"), RemittanceParseError);
});
