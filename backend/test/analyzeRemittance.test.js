import test from "node:test";
import assert from "node:assert/strict";

import { parseRemittanceClaim } from "../src/pipeline/parseRemittance.js";
import { analyzeRemittance } from "../src/pipeline/analyzeRemittance.js";
import { loadAdjustmentCodes } from "../../reference/loadAdjustmentCodes.mjs";

const codes = await loadAdjustmentCodes();

function analyze(claim, options = {}) {
  return analyzeRemittance(parseRemittanceClaim(claim), codes, { today: "2026-09-08", ...options });
}

// All synthetic. See reference/README.md -- a real 835 must never land here.
function deniedFor(reasonCode, { groupCode = "CO", amount = "150.00", code = "99213" } = {}) {
  return {
    payerClaimControlNumber: "2026250012345",
    claimStatusCode: 4,
    productionDate: "2026-09-01",
    totalClaimChargeAmount: amount,
    claimPaymentAmount: "0.00",
    serviceLines: [
      {
        procedureCode: code,
        lineItemChargeAmount: amount,
        lineItemProviderPaymentAmount: "0.00",
        adjustments: [{ adjustmentGroupCode: groupCode, adjustmentReasonCode: reasonCode, adjustmentAmount: amount }],
      },
    ],
  };
}

test("a medical-necessity denial routes to appeal and counts as money at risk", () => {
  const result = analyze(deniedFor("50"));

  assert.equal(result.recommendedRoute, "appeal");
  assert.equal(result.money.atRisk, 150);
  assert.equal(result.money.patientResponsibility, 0);

  const finding = result.findings[0];
  assert.equal(finding.category, "documentation");
  assert.equal(finding.known, true);
  assert.match(finding.description, /medical necessity/i);
  // The explanation should point at what Ruby can actually do about it.
  assert.match(finding.explanation, /transcript/i);
});

test("a deductible is billed to the patient, not treated as recoverable", () => {
  const result = analyze(deniedFor("1", { groupCode: "PR" }));

  assert.equal(result.recommendedRoute, "bill_patient");
  assert.equal(result.money.patientResponsibility, 150);
  // The whole point: this is not money to chase the payer for.
  assert.equal(result.money.atRisk, 0);
  assert.equal(result.findings[0].billableToPatient, true);
});

test("a contractual write-down on a paid claim needs no action", () => {
  const result = analyze({
    claimStatusCode: 1,
    totalClaimChargeAmount: "200.00",
    claimPaymentAmount: "170.00",
    serviceLines: [
      {
        procedureCode: "99213",
        lineItemChargeAmount: "200.00",
        lineItemProviderPaymentAmount: "170.00",
        adjustments: [{ adjustmentGroupCode: "CO", adjustmentReasonCode: "45", adjustmentAmount: "30.00" }],
      },
    ],
  });

  assert.equal(result.recommendedRoute, "no_action");
  assert.equal(result.money.contractualWriteOff, 30);
  assert.equal(result.money.atRisk, 0);
  assert.equal(result.money.paid, 170);
});

test("a coding mismatch routes to a corrected claim", () => {
  const result = analyze(deniedFor("11"));
  assert.equal(result.recommendedRoute, "correct_and_resubmit");
  assert.equal(result.findings[0].category, "coding");
});

test("bundling never auto-corrects -- it goes to a human", () => {
  // Unbundling to get paid is how practices end up in fraud territory. The
  // payer's edit is often correct, so this must not route to "resubmit".
  const result = analyze(deniedFor("97"));
  assert.equal(result.findings[0].category, "bundling");
  assert.equal(result.recommendedRoute, "review_manually");
});

test("an unrecognised reason code is surfaced raw and sent to a human", () => {
  const result = analyze(deniedFor("9999"));

  const finding = result.findings[0];
  assert.equal(finding.known, false);
  assert.equal(finding.reasonCode, "9999");
  assert.equal(finding.description, "");
  assert.equal(result.recommendedRoute, "review_manually");
  // Still counted as money at risk -- unknown does not mean unimportant.
  assert.equal(result.money.atRisk, 150);
});

test("the headline route follows the biggest recoverable amount", () => {
  const result = analyze({
    payerClaimControlNumber: "2026250012345",
    claimStatusCode: 4,
    totalClaimChargeAmount: "400.00",
    claimPaymentAmount: "0.00",
    serviceLines: [
      {
        procedureCode: "99213",
        lineItemChargeAmount: "100.00",
        lineItemProviderPaymentAmount: "0.00",
        adjustments: [{ adjustmentGroupCode: "CO", adjustmentReasonCode: "11", adjustmentAmount: "100.00" }],
      },
      {
        procedureCode: "20610",
        lineItemChargeAmount: "300.00",
        lineItemProviderPaymentAmount: "0.00",
        adjustments: [{ adjustmentGroupCode: "CO", adjustmentReasonCode: "50", adjustmentAmount: "300.00" }],
      },
    ],
  });

  // Both a coding fix and an appeal are on the table; the appeal is worth 3x.
  assert.equal(result.recommendedRoute, "appeal");
  assert.equal(result.money.atRisk, 400);
  assert.equal(result.findings.length, 2);
});

test("says up front whether a corrected claim can even be filed", () => {
  assert.equal(analyze(deniedFor("11")).canFileCorrectedClaim, true);

  const noControlNumber = analyze({ ...deniedFor("11"), payerClaimControlNumber: undefined });
  assert.equal(noControlNumber.canFileCorrectedClaim, false);
  assert.equal(noControlNumber.payerClaimControlNumber, null);
});

test("the filing and appeal clocks are computed, and flagged as defaults", () => {
  const result = analyze(deniedFor("50"), { dateOfService: "2026-08-01", today: "2026-09-08" });

  // 180 days from the visit, 90 from the remittance -- both stand-ins until
  // real payer contracts are loaded, and the output has to admit that.
  assert.equal(result.deadlines.isDefault, true);
  assert.equal(result.deadlines.filingDeadline, "2027-01-28");
  assert.equal(result.deadlines.filingDaysRemaining, 142);
  assert.equal(result.deadlines.appealDeadline, "2026-11-30");
  assert.equal(result.deadlines.appealDaysRemaining, 83);
});

test("an expired window shows as negative days rather than silently passing", () => {
  const result = analyze(deniedFor("50"), { dateOfService: "2025-01-01", today: "2026-09-08" });
  assert.ok(result.deadlines.filingDaysRemaining < 0);
});

test("a billed line the payer never ruled on is caught separately", () => {
  // Not a denial, so nothing in the findings would catch it -- but it is
  // money that quietly went nowhere.
  const result = analyze(deniedFor("50", { code: "99213" }), {
    submittedClaim: { serviceLines: [{ code: "99213" }, { code: "87880" }] },
  });

  assert.deepEqual(result.unadjudicatedLines, ["87880"]);
});

test("remark codes are resolved alongside the reason codes", () => {
  const result = analyze({
    ...deniedFor("50"),
    serviceLines: [
      {
        procedureCode: "99213",
        lineItemChargeAmount: "150.00",
        lineItemProviderPaymentAmount: "0.00",
        adjustments: [{ adjustmentGroupCode: "CO", adjustmentReasonCode: "50", adjustmentAmount: "150.00" }],
        remarkCodes: ["N115", "ZZ999"],
      },
    ],
  });

  assert.equal(result.remarks.length, 2);
  assert.equal(result.remarks[0].known, true);
  assert.match(result.remarks[0].description, /Local Coverage Determination/i);
  assert.equal(result.remarks[1].known, false);
});
