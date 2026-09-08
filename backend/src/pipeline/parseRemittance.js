// Turns a payer's 835 remittance into Ruby's own adjudication shape.
//
// Deterministic. No model call, no lookups, no judgement -- this only restates
// what the payer sent in a shape the rest of the app can work with. Explaining
// the reason codes is analyzeRemittance.js's job, and what to *do* about them
// is a decision that comes after that.
//
// ---------------------------------------------------------------------------
// UNVERIFIED AGAINST A LIVE PAYLOAD.
//
// The 835 semantics below are the standard ones (CLP for the claim, SVC for a
// service line, CAS for adjustments), but nobody has yet run a claim through
// Stedi's sandbox and looked at what actually comes back -- that needs a real
// STEDI_API_KEY and network access to Stedi, neither of which a cloud session
// has. Every field-name guess is therefore funnelled through FIELDS below, so
// correcting this against a real remittance is an edit in one place rather
// than a rewrite.
// ---------------------------------------------------------------------------

export class RemittanceParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemittanceParseError";
  }
}

// CLP02. The payer's own verdict on the claim, which beats anything we could
// infer from the amounts.
const CLAIM_STATUS_CODES = {
  1: "paid", // processed as primary
  2: "paid", // processed as secondary
  3: "paid", // processed as tertiary
  4: "denied",
  19: "forwarded", // processed as primary, forwarded to additional payer
  20: "forwarded",
  21: "forwarded",
  22: "reversed", // reversal of a previous payment
  23: "not_our_claim",
  25: "predetermination",
};

// Every guess about what Stedi calls a field lives here. First key that is
// actually present wins.
const FIELDS = {
  claims: ["claims", "claimPayments", "claimPaymentInfo", "payments"],
  lines: ["serviceLines", "services", "serviceLineInfo", "lines"],
  claimAdjustments: ["claimAdjustments", "adjustments", "claimLevelAdjustments"],
  lineAdjustments: ["serviceAdjustments", "adjustments", "lineAdjustments"],
  controlNumber: ["payerClaimControlNumber", "claimControlNumber", "payerControlNumber", "icn", "dcn"],
  claimStatusCode: ["claimStatusCode", "claimStatus", "statusCode"],
  billed: ["totalClaimChargeAmount", "claimChargeAmount", "chargeAmount", "billedAmount", "submittedCharges"],
  paid: ["claimPaymentAmount", "paymentAmount", "paidAmount"],
  patientResponsibility: ["patientResponsibilityAmount", "patientResponsibility", "patientLiability"],
  procedureCode: ["procedureCode", "serviceCode", "adjudicatedProcedureCode", "code"],
  lineBilled: ["lineItemChargeAmount", "chargeAmount", "billedAmount", "submittedCharge"],
  linePaid: ["lineItemProviderPaymentAmount", "paymentAmount", "paidAmount"],
  units: ["unitsOfServicePaidCount", "units", "quantity"],
  modifiers: ["procedureModifiers", "modifiers"],
  groupCode: ["adjustmentGroupCode", "groupCode", "claimAdjustmentGroupCode"],
  reasonCode: ["adjustmentReasonCode", "reasonCode", "claimAdjustmentReasonCode"],
  adjustmentAmount: ["adjustmentAmount", "amount", "monetaryAmount"],
  remarkCodes: ["remarkCodes", "remittanceRemarkCodes", "healthCareRemarkCodes", "lqCodes"],
  payerName: ["payerName", "payer", "payerIdentification"],
  remittanceDate: ["productionDate", "checkIssueOrEftEffectiveDate", "paymentDate", "effectiveDate"],
  traceNumber: ["checkOrEftTraceNumber", "traceNumber", "checkNumber"],
};

function pick(source, names) {
  if (!source || typeof source !== "object") return undefined;
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null && source[name] !== "") return source[name];
  }
  return undefined;
}

// 835 amounts arrive as decimal dollars, sometimes as strings. Rounding to
// cents on the way in keeps float drift out of every later comparison --
// "paid < billed" deciding a claim was underpaid by 0.000000001 would be a
// silly way to open an appeal.
export function money(value) {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? "").replace(/[$,\s]/g, ""));
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// One CAS segment carries a group code and up to six reason/amount pairs. Some
// representations flatten that into one object per pair, others nest the pairs
// -- accept both rather than assuming.
function parseAdjustments(raw) {
  const out = [];
  for (const entry of asArray(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const groupCode = String(pick(entry, FIELDS.groupCode) ?? "").toUpperCase();

    const nested = asArray(entry.adjustmentDetails || entry.details || entry.reasons);
    if (nested.length > 0) {
      for (const detail of nested) {
        out.push({
          groupCode,
          reasonCode: String(pick(detail, FIELDS.reasonCode) ?? ""),
          amount: money(pick(detail, FIELDS.adjustmentAmount)),
        });
      }
      continue;
    }

    out.push({
      groupCode,
      reasonCode: String(pick(entry, FIELDS.reasonCode) ?? ""),
      amount: money(pick(entry, FIELDS.adjustmentAmount)),
    });
  }
  return out.filter((a) => a.reasonCode);
}

function parseLine(raw) {
  return {
    procedureCode: String(pick(raw, FIELDS.procedureCode) ?? ""),
    modifiers: asArray(pick(raw, FIELDS.modifiers)).map((m) => String(m)),
    units: Number(pick(raw, FIELDS.units) ?? 1) || 1,
    billed: money(pick(raw, FIELDS.lineBilled)),
    paid: money(pick(raw, FIELDS.linePaid)),
    adjustments: parseAdjustments(pick(raw, FIELDS.lineAdjustments)),
    remarkCodes: asArray(pick(raw, FIELDS.remarkCodes)).map((c) => String(c)),
  };
}

// The payer's own status code wins when we have one. Inferring from amounts is
// the fallback, and it is genuinely ambiguous: a claim paid at zero because
// the whole charge went to the deductible is not "denied", even though the
// provider received nothing.
function resolveStatus(statusCode, totals, adjustments) {
  const mapped = CLAIM_STATUS_CODES[Number(statusCode)];
  if (mapped) return mapped;

  if (totals.paid > 0) return totals.paid < totals.billed ? "partially_paid" : "paid";
  const allPatientResponsibility =
    adjustments.length > 0 && adjustments.every((a) => a.groupCode === "PR");
  if (allPatientResponsibility) return "patient_responsibility";
  return adjustments.length > 0 ? "denied" : "unknown";
}

/**
 * @param {object} remittance  One claim's worth of 835 data, as returned by
 *   Stedi (or a synthetic fixture in the same shape).
 * @returns {object} Ruby's adjudication shape.
 */
export function parseRemittanceClaim(raw) {
  if (!raw || typeof raw !== "object") {
    throw new RemittanceParseError("A remittance claim must be an object.");
  }

  const lines = asArray(pick(raw, FIELDS.lines)).map(parseLine);
  const claimAdjustments = parseAdjustments(pick(raw, FIELDS.claimAdjustments));

  const billed = money(pick(raw, FIELDS.billed));
  const paid = money(pick(raw, FIELDS.paid));
  const patientResponsibility = money(pick(raw, FIELDS.patientResponsibility));

  const everyAdjustment = [...claimAdjustments, ...lines.flatMap((l) => l.adjustments)];

  const totals = {
    billed: billed || money(lines.reduce((sum, l) => sum + l.billed, 0)),
    paid: paid || money(lines.reduce((sum, l) => sum + l.paid, 0)),
    patientResponsibility:
      patientResponsibility ||
      money(everyAdjustment.filter((a) => a.groupCode === "PR").reduce((sum, a) => sum + a.amount, 0)),
  };

  const statusCode = pick(raw, FIELDS.claimStatusCode);

  return {
    // Without this a corrected claim cannot be filed -- the payer reads a
    // resubmission with no control number as a brand-new claim and denies it
    // as a duplicate. It is the single most important field on the document.
    payerClaimControlNumber: String(pick(raw, FIELDS.controlNumber) ?? "") || null,
    claimStatusCode: statusCode === undefined ? null : String(statusCode),
    status: resolveStatus(statusCode, totals, everyAdjustment),
    payerName: String(pick(raw, FIELDS.payerName) ?? "") || null,
    remittanceDate: String(pick(raw, FIELDS.remittanceDate) ?? "") || null,
    traceNumber: String(pick(raw, FIELDS.traceNumber) ?? "") || null,
    totals,
    claimAdjustments,
    lines,
    remarkCodes: asArray(pick(raw, FIELDS.remarkCodes)).map((c) => String(c)),
  };
}

/**
 * A remittance document can cover many claims at once. Returns one parsed
 * adjudication per claim, in document order.
 */
export function parseRemittance(document) {
  if (!document || typeof document !== "object") {
    throw new RemittanceParseError("A remittance document must be an object.");
  }
  const claims = asArray(pick(document, FIELDS.claims));
  if (claims.length === 0) {
    // A single-claim payload with no wrapper is worth accepting rather than
    // failing on -- it is exactly what a hand-written fixture looks like.
    return [parseRemittanceClaim(document)];
  }

  const payerName = String(pick(document, FIELDS.payerName) ?? "") || null;
  const remittanceDate = String(pick(document, FIELDS.remittanceDate) ?? "") || null;

  return claims.map((claim) => {
    const parsed = parseRemittanceClaim(claim);
    // Payer and date usually sit on the document, not on each claim.
    return {
      ...parsed,
      payerName: parsed.payerName || payerName,
      remittanceDate: parsed.remittanceDate || remittanceDate,
    };
  });
}
