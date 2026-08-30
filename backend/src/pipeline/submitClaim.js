// Simulated claim submission. No payer or clearinghouse connection exists, so
// this never contacts anything real -- it manufactures a confirmation the way
// a payer's intake system would, so the UI has something honest to show for
// "submitted" instead of quietly doing nothing.

import { randomBytes } from "node:crypto";

export class SubmissionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SubmissionError";
  }
}

function confirmationNumber() {
  return `MOCK-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export function submitClaim(claim) {
  if (!claim || typeof claim !== "object") {
    throw new SubmissionError("No claim to submit.");
  }
  if (!Array.isArray(claim.diagnoses) || claim.diagnoses.length === 0) {
    throw new SubmissionError("A claim needs at least one diagnosis before it can be submitted.");
  }
  if (!Array.isArray(claim.serviceLines) || claim.serviceLines.length === 0) {
    throw new SubmissionError("A claim needs at least one service line before it can be submitted.");
  }

  // Always "accepted": this stage is not a payer adjudication model, just proof
  // that a submission step exists end-to-end. Real acceptance/denial logic
  // belongs to an actual clearinghouse integration, not a guess standing in for one.
  return {
    simulated: true,
    status: "accepted",
    confirmationNumber: confirmationNumber(),
    payerName: claim.payer?.name || "Sample Payer Insurance",
    submittedAt: new Date().toISOString(),
  };
}
