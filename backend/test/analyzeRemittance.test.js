import test from "node:test";
import assert from "node:assert/strict";

import { parseRemittance } from "../src/pipeline/parseRemittance.js";
import { analyzeRemittance } from "../src/pipeline/analyzeRemittance.js";
import { loadAdjustmentCodes } from "../../reference/loadAdjustmentCodes.mjs";

const codes = await loadAdjustmentCodes();

// Builds a synthetic 835 in the shape confirmed against a real Stedi Test
// Payer response (see parseRemittance.js's header comment and
// parseRemittance.test.js's REAL_STEDI_ERA). All data here is synthetic --
// see reference/README.md.
function buildEra({
  statusCode = "1",
  billed = "100",
  paid = "0",
  patientResponsibility = "0",
  payerClaimControlNumber = "2026250012345",
  remittanceDate = "20260901",
  claimAdjustments = [],
  lines = [{ code: "99213", billed: "100", paid: "0", adjustments: [] }],
} = {}) {
  const casSegment = (adj) => `CAS*${adj.groupCode}*${adj.reasonCode}*${adj.amount}~`;

  const lineSegments = lines.flatMap((l) => [
    `SVC*HC\`${l.code}*${l.billed}*${l.paid}**1*HC\`${l.code}*1~`,
    `DTM*472*${remittanceDate}~`,
    ...(l.adjustments || []).map(casSegment),
    ...(l.remarkCodes || []).map((code) => `LQ*HE*${code}~`),
  ]);

  return [
    "ISA*00*          *00*          *ZZ*STEDITEST      *ZZ*134129016687   *260908*1907*^*00501*000000010*0*T*`~",
    "GS*HP*STEDITEST*134129016687*20260908*190744*10*X*005010X221A1~",
    "ST*835*0001~",
    `BPR*I*${paid}*C*ACH************${remittanceDate}~`,
    "TRN*1*trace*1234567890~",
    `DTM*405*${remittanceDate}~`,
    "N1*PR*Stedi Test Payer*XV*STEDI~",
    "LX*1~",
    `CLP*ruby-1*${statusCode}*${billed}*${paid}*${patientResponsibility}*ZZ*${payerClaimControlNumber}*11*1~`,
    ...claimAdjustments.map(casSegment),
    `DTM*232*${remittanceDate}~`,
    ...lineSegments,
    "SE*20*0001~",
    "GE*1*10~",
    "IEA*1*000000010~",
  ].join("\n");
}

function analyze(x12, options = {}) {
  const [claim] = parseRemittance(x12);
  return analyzeRemittance(claim, codes, { today: "2026-09-08", ...options });
}

function deniedFor(reasonCode, { groupCode = "CO", amount = "150", code = "99213", payerClaimControlNumber } = {}) {
  return buildEra({
    statusCode: "4",
    billed: amount,
    paid: "0",
    ...(payerClaimControlNumber !== undefined ? { payerClaimControlNumber } : {}),
    lines: [{ code, billed: amount, paid: "0", adjustments: [{ groupCode, reasonCode, amount }] }],
  });
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
  const result = analyze(
    buildEra({
      statusCode: "1",
      billed: "200",
      paid: "170",
      lines: [{ code: "99213", billed: "200", paid: "170", adjustments: [{ groupCode: "CO", reasonCode: "45", amount: "30" }] }],
    })
  );

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
  const result = analyze(
    buildEra({
      statusCode: "4",
      billed: "400",
      paid: "0",
      lines: [
        { code: "99213", billed: "100", paid: "0", adjustments: [{ groupCode: "CO", reasonCode: "11", amount: "100" }] },
        { code: "20610", billed: "300", paid: "0", adjustments: [{ groupCode: "CO", reasonCode: "50", amount: "300" }] },
      ],
    })
  );

  // Both a coding fix and an appeal are on the table; the appeal is worth 3x.
  assert.equal(result.recommendedRoute, "appeal");
  assert.equal(result.money.atRisk, 400);
  assert.equal(result.findings.length, 2);
});

test("says up front whether a corrected claim can even be filed", () => {
  assert.equal(analyze(deniedFor("11")).canFileCorrectedClaim, true);

  const noControlNumber = analyze(deniedFor("11", { payerClaimControlNumber: "" }));
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
  const result = analyze(
    buildEra({
      statusCode: "4",
      billed: "150",
      paid: "0",
      lines: [
        {
          code: "99213",
          billed: "150",
          paid: "0",
          adjustments: [{ groupCode: "CO", reasonCode: "50", amount: "150" }],
          remarkCodes: ["N115", "ZZ999"],
        },
      ],
    })
  );

  assert.equal(result.remarks.length, 2);
  assert.equal(result.remarks[0].known, true);
  assert.match(result.remarks[0].description, /Local Coverage Determination/i);
  assert.equal(result.remarks[1].known, false);
});
