// Submits a mapped 837P claim to Stedi. Talks to the same URL in sandbox and
// production -- Stedi tells test vs. real submissions apart by which API key
// mode you used to authenticate (test keys only reach the sandbox/QA network).

const STEDI_CLAIMS_URL =
  "https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/professionalclaims/v3/submission";

export class StediSubmissionError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "StediSubmissionError";
    this.details = details;
  }
}

/**
 * @param {object} stediClaim  Output of buildStediClaim().
 * @param {string} apiKey      Stedi API key (test or production mode).
 * @param {string} [idempotencyKey] Defaults to a fresh one per call -- pass
 *   the same value on a manual retry to avoid a duplicate submission.
 */
export async function submitToStedi(stediClaim, apiKey, idempotencyKey) {
  if (!apiKey) {
    throw new StediSubmissionError("STEDI_API_KEY is not configured.");
  }

  const key = idempotencyKey || `ruby-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  const response = await fetch(STEDI_CLAIMS_URL, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(stediClaim),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok) {
    throw new StediSubmissionError(
      `Stedi rejected the claim submission (HTTP ${response.status}).`,
      body
    );
  }

  return body;
}
