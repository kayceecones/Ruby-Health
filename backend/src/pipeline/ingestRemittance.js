// Takes a payer document and files it: parse it, read it, keep the original,
// record what it said, and move the claim to where the payer just put it.
//
// Lives here rather than inside the route handler so the orchestration is
// testable without an HTTP server, and so the route stays what routes should
// be -- argument checking and a response.
//
// Today the document is handed in by the caller. Once someone has confirmed
// what Stedi actually returns and how to fetch it, automatic retrieval feeds
// this same function and nothing below has to change.

import { parseRemittance } from "./parseRemittance.js";
import { analyzeRemittance } from "./analyzeRemittance.js";

// Ruby's Claim carries five statuses; an 835 distinguishes more than that.
// The finer verdict is kept in full on the PayerFeedback row -- this only
// decides which of the five the claim itself now sits in.
export const CLAIM_STATUS_FROM_ADJUDICATION = {
  paid: "accepted",
  partially_paid: "accepted",
  // The provider was paid nothing, but the payer did adjudicate it and the
  // balance is legitimately the patient's. That is an accepted claim with a
  // bill to send, not a denial.
  patient_responsibility: "accepted",
  denied: "denied",
  not_our_claim: "denied",
  reversed: "pending",
  forwarded: "pending",
  predetermination: "pending",
  unknown: "pending",
};

export class RemittanceIngestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "RemittanceIngestError";
    this.status = status;
  }
}

/**
 * @param {object} deps
 * @param {object} deps.repository
 * @param {object} [deps.blobStore]       Optional -- a storage failure must
 *   not lose the reading of a document we already parsed successfully.
 * @param {object} deps.adjustmentCodes   From loadAdjustmentCodes().
 * @param {string} deps.claimId
 * @param {object} deps.remittance        The payer's raw payload.
 * @param {string} [deps.dateOfService]   For the filing-deadline clock.
 * @param {object} [deps.submittedClaim]  To spot lines never adjudicated.
 * @param {string} [deps.today]           Injected so the clocks are testable.
 */
export async function ingestRemittance({
  repository,
  blobStore,
  adjustmentCodes,
  claimId,
  remittance,
  dateOfService,
  submittedClaim,
  today,
}) {
  if (!remittance || typeof remittance !== "object") {
    throw new RemittanceIngestError("A remittance payload is required.");
  }

  const claim = await repository.getClaim(claimId);
  if (!claim) throw new RemittanceIngestError(`No claim found with claim_id '${claimId}'.`, 404);

  // A remittance document can cover several claims at once. Only the one this
  // was called for is filed; the count of the others is returned so a caller
  // handling a real multi-claim payload knows there is more to route.
  const parsedClaims = parseRemittance(remittance);
  const adjudication = parsedClaims[0];
  const analysis = analyzeRemittance(adjudication, adjustmentCodes, { dateOfService, submittedClaim, today });

  // Keep the document itself, not just our reading of it. The parser's field
  // mapping is still unverified against a live payer payload -- if it turns
  // out to have read something wrong, the original is here to re-read rather
  // than gone.
  let storageRef = null;
  if (blobStore) {
    try {
      storageRef = await blobStore.putBlob(
        `remittance/${claimId}-${Date.now()}.json`,
        Buffer.from(JSON.stringify(remittance, null, 2))
      );
    } catch (err) {
      console.error(`Storing the raw remittance for claim '${claimId}' failed:`, err);
    }
  }

  const feedback = await repository.createPayerFeedback({
    claimId,
    feedbackType: "remittance",
    receivedAt: adjudication.remittanceDate || new Date().toISOString().slice(0, 10),
    payerClaimControlNumber: adjudication.payerClaimControlNumber || "",
    claimStatus: adjudication.status,
    recommendedRoute: analysis.recommendedRoute,
    amountAtRisk: analysis.money.atRisk,
    storageRef,
    content: { adjudication, analysis },
  });

  // These two are what make the claim actionable afterwards: the control
  // number is required to file a correction, and the status is what the
  // History activity feed has been rendering all along without anything ever
  // moving it past "submitted".
  if (adjudication.payerClaimControlNumber) {
    await repository.setPayerClaimControlNumber(claimId, adjudication.payerClaimControlNumber);
  }
  const claimStatus = CLAIM_STATUS_FROM_ADJUDICATION[adjudication.status] || "pending";
  await repository.updateClaimStatus(claimId, claimStatus);

  return { feedback, analysis, claimStatus, otherClaimsInDocument: parsedClaims.length - 1 };
}
