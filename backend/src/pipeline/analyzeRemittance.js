// Reads a parsed adjudication and says what happened, what it means, and what
// to do next.
//
// Deterministic on purpose, and this is the sharpest place in the app to hold
// that line. Which codes mean "the patient owes this", which mean "we can
// appeal", and what the money splits into is lookup and arithmetic. A model
// asked to do it would be fluent and occasionally wrong, and every one of
// these answers is about real money -- a wrongly-billed patient, an unbilled
// write-off, a missed appeal window.
//
// The model's turn comes after this: given a finding that says "denied for
// medical necessity, appealable", drafting the appeal from the encounter
// transcript is genuine judgement and lives in its own stage.

import { describeCarc, describeGroupCode, describeRarc } from "../../../reference/loadAdjustmentCodes.mjs";

// What Ruby does about each kind of problem. Deliberately conservative:
// anything where the mechanical answer could be wrong routes to a human
// instead of guessing.
const ROUTE_BY_CATEGORY = {
  patient_responsibility: "bill_patient",
  contractual: "no_action",
  coding: "correct_and_resubmit",
  documentation: "appeal",
  authorization: "obtain_authorization",
  eligibility: "verify_eligibility",
  coordination_of_benefits: "rebill_other_payer",
  // Bundling is usually the payer applying a correct edit. Unbundling to get
  // paid is how practices end up in fraud territory, so this never
  // auto-corrects -- a human decides whether the edit was actually wrong.
  bundling: "review_manually",
  duplicate: "review_manually",
  timely_filing: "review_manually",
  credentialing: "review_manually",
  unknown: "review_manually",
};

// Plain-language, written for someone who is not a coder. These say what the
// payer's decision means in practice and what would move it, not just a
// restatement of the code's title.
const EXPLANATION_BY_CATEGORY = {
  patient_responsibility: "Not a denial -- this is the patient's share under their plan. Bill the patient.",
  contractual: "Not a denial -- this is the normal difference between the charge and the contracted rate. Nothing to do.",
  coding: "The payer could not accept the claim as coded. Fixing the codes and filing a corrected claim is the usual path.",
  documentation:
    "The payer says the record does not justify the service. This is the appealable kind -- Ruby has the visit transcript, so the appeal can quote what was actually documented.",
  authorization: "Prior authorization was missing or did not cover this. Some payers accept a retroactive request; otherwise this is an appeal.",
  eligibility: "A coverage problem rather than a coding one -- the patient's plan, dates, or the payer itself. Check eligibility before resubmitting anywhere.",
  coordination_of_benefits: "Another payer comes first. This needs the primary payer's remittance before it can be finished.",
  bundling: "The payer treated this as already included in another service. Sometimes correct, sometimes not -- worth a human look before challenging it.",
  duplicate: "The payer already has this claim. Check whether the original was paid before sending anything else.",
  timely_filing: "The filing window closed. Usually unrecoverable unless there is proof the claim was sent on time.",
  credentialing: "A provider enrolment problem, not a claim problem. This needs fixing with the payer directly.",
  unknown: "Ruby does not carry this reason code, so it is shown exactly as the payer sent it. Worth looking up before acting.",
};

// Which routes represent money that could still be recovered, ranked by how
// clear the next step is. Used to pick one headline route when a claim carries
// several different problems at once.
const ROUTE_PRIORITY = [
  "correct_and_resubmit",
  "appeal",
  "obtain_authorization",
  "rebill_other_payer",
  "verify_eligibility",
  "review_manually",
  "bill_patient",
  "no_action",
];

// Both are stand-ins until real payer contracts are loaded. 180 days from the
// visit is a common filing limit and 90 days from the remittance a common
// appeal window, but these genuinely vary per payer -- and a deadline that is
// wrong in the optimistic direction loses the money outright. Flagged as a
// default in the output so nothing downstream presents it as fact.
export const DEFAULT_FILING_DAYS = 180;
export const DEFAULT_APPEAL_DAYS = 90;

function addDays(date, days) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso, toIso) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return null;
  return Math.round((to - from) / 86400000);
}

function round(n) {
  return Math.round(n * 100) / 100;
}

function toFinding(codes, adjustment, scope, procedureCode) {
  const carc = describeCarc(codes, adjustment.reasonCode);
  const group = describeGroupCode(codes, adjustment.groupCode);
  const category = carc.category;

  return {
    scope,
    procedureCode: procedureCode || null,
    groupCode: adjustment.groupCode,
    groupMeaning: group.meaning || "",
    reasonCode: carc.code,
    amount: round(adjustment.amount),
    description: carc.description,
    known: carc.known,
    category,
    route: ROUTE_BY_CATEGORY[category] || "review_manually",
    explanation: EXPLANATION_BY_CATEGORY[category] || EXPLANATION_BY_CATEGORY.unknown,
    // Only PR amounts may be sent to the patient. Everything else is either
    // absorbed or fought for.
    billableToPatient: group.billable === true,
  };
}

/**
 * @param {object} adjudication  Output of parseRemittanceClaim().
 * @param {object} codes         Output of loadAdjustmentCodes().
 * @param {object} [options]
 * @param {string} [options.dateOfService]  For the filing-deadline clock.
 * @param {string} [options.today]          Injected so the clock is testable.
 * @param {number} [options.filingDays]
 * @param {number} [options.appealDays]
 * @param {object} [options.submittedClaim] Ruby's original claim, to spot
 *   service lines the payer never adjudicated at all.
 */
export function analyzeRemittance(adjudication, codes, options = {}) {
  const { dateOfService, filingDays = DEFAULT_FILING_DAYS, appealDays = DEFAULT_APPEAL_DAYS, submittedClaim } = options;
  const today = options.today || new Date().toISOString().slice(0, 10);

  const findings = [
    ...adjudication.claimAdjustments.map((a) => toFinding(codes, a, "claim", null)),
    ...adjudication.lines.flatMap((line) =>
      line.adjustments.map((a) => toFinding(codes, a, "line", line.procedureCode))
    ),
  ];

  const remarks = [
    ...adjudication.remarkCodes,
    ...adjudication.lines.flatMap((l) => l.remarkCodes),
  ].map((code) => describeRarc(codes, code));

  const patientResponsibility = round(
    findings.filter((f) => f.billableToPatient).reduce((sum, f) => sum + f.amount, 0)
  );
  const contractual = round(
    findings.filter((f) => f.category === "contractual").reduce((sum, f) => sum + f.amount, 0)
  );

  // The number that actually matters: billed money that was neither paid, nor
  // legitimately the patient's, nor a contracted write-down. This is what is
  // still recoverable, and it is what should drive whether chasing a denial is
  // worth anyone's afternoon.
  const atRisk = round(
    findings
      .filter((f) => !f.billableToPatient && f.category !== "contractual")
      .reduce((sum, f) => sum + f.amount, 0)
  );

  const actionable = findings.filter((f) => f.route !== "no_action" && f.route !== "bill_patient");
  const headline = [...actionable].sort(
    (a, b) => b.amount - a.amount || ROUTE_PRIORITY.indexOf(a.route) - ROUTE_PRIORITY.indexOf(b.route)
  )[0];

  let recommendedRoute;
  if (headline) recommendedRoute = headline.route;
  else if (patientResponsibility > 0) recommendedRoute = "bill_patient";
  else recommendedRoute = "no_action";

  // A corrected claim needs the payer's control number. Saying so up front
  // beats discovering it at resubmission time, when the payer bounces the
  // claim as a duplicate.
  const canFileCorrectedClaim = Boolean(adjudication.payerClaimControlNumber);

  const filingDeadline = dateOfService ? addDays(dateOfService, filingDays) : null;
  const appealDeadline = adjudication.remittanceDate ? addDays(adjudication.remittanceDate, appealDays) : null;

  const submittedCodes = new Set(
    (submittedClaim?.serviceLines || []).map((l) => String(l.code || "").toUpperCase()).filter(Boolean)
  );
  const adjudicatedCodes = new Set(adjudication.lines.map((l) => l.procedureCode.toUpperCase()).filter(Boolean));
  const unadjudicatedLines = [...submittedCodes].filter((code) => !adjudicatedCodes.has(code));

  return {
    status: adjudication.status,
    payerClaimControlNumber: adjudication.payerClaimControlNumber,
    canFileCorrectedClaim,
    money: {
      billed: round(adjudication.totals.billed),
      paid: round(adjudication.totals.paid),
      patientResponsibility,
      contractualWriteOff: contractual,
      atRisk,
    },
    findings,
    remarks,
    // A line we billed that the payer never ruled on at all is its own kind of
    // problem -- it is not a denial, so nothing above catches it.
    unadjudicatedLines,
    recommendedRoute,
    deadlines: {
      // Both are defaults, not this payer's actual contract terms. Anything
      // showing these to a human has to say so.
      isDefault: true,
      filingDeadline,
      filingDaysRemaining: filingDeadline ? daysBetween(today, filingDeadline) : null,
      appealDeadline,
      appealDaysRemaining: appealDeadline ? daysBetween(today, appealDeadline) : null,
    },
  };
}
