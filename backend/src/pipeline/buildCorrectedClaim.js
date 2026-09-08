// Applies suggested code changes to a populated claim, producing what a
// corrected resubmission should carry.
//
// Deterministic. Whether to accept a suggested change is a judgement a human
// already made by choosing to resubmit -- this only carries out the edit,
// the same "propose vs. apply" split as everywhere else in the denial loop.

export class CorrectedClaimError extends Error {
  constructor(message) {
    super(message);
    this.name = "CorrectedClaimError";
  }
}

/**
 * @param {object} claim  Output of populateClaim() (or its stored artifact
 *   content) -- the claim as it was originally submitted.
 * @param {Array<{currentCode: string, suggestedCode: string, reason?: string}>} suggestedCodeChanges
 *   From draftAppeal()'s output. A denial that the diagnosis doesn't support
 *   the procedure can be fixed on either side -- a different procedure code,
 *   or a different (or additional) diagnosis -- so a currentCode is checked
 *   against both service lines (CPT) and diagnoses (ICD-10), not just one.
 *   An empty suggestedCode drops the line or the diagnosis.
 */
export function buildCorrectedClaim(claim, suggestedCodeChanges = []) {
  if (!claim || !Array.isArray(claim.serviceLines) || !Array.isArray(claim.diagnoses)) {
    throw new CorrectedClaimError("buildCorrectedClaim requires a populated claim object with serviceLines and diagnoses.");
  }
  if (!Array.isArray(suggestedCodeChanges) || suggestedCodeChanges.length === 0) {
    throw new CorrectedClaimError("No code changes were given -- nothing to correct.");
  }

  const changesByCode = new Map();
  for (const change of suggestedCodeChanges) {
    if (change?.currentCode) changesByCode.set(String(change.currentCode), change);
  }

  // A change naming a code the claim doesn't have is a sign the appeal draft
  // and the claim have drifted apart -- surfacing that beats silently
  // ignoring it and resubmitting something the reviewer didn't actually see.
  const unmatched = new Set(changesByCode.keys());

  const serviceLines = [];
  for (const line of claim.serviceLines) {
    const change = changesByCode.get(line.code);
    if (!change) {
      serviceLines.push(line);
      continue;
    }
    unmatched.delete(line.code);
    if (!change.suggestedCode) continue; // an empty suggestion means drop the line
    serviceLines.push({ ...line, code: change.suggestedCode });
  }

  const diagnoses = [];
  for (const diagnosis of claim.diagnoses) {
    const change = changesByCode.get(diagnosis.code);
    if (!change) {
      diagnoses.push(diagnosis);
      continue;
    }
    unmatched.delete(diagnosis.code);
    if (!change.suggestedCode) continue; // an empty suggestion means drop the diagnosis
    // The pointer letter (A, B, C...) stays put -- it's what serviceLines'
    // diagnosisPointers reference, and buildStediClaim resolves it fresh
    // from whatever diagnoses survive, in whatever order they're in here.
    diagnoses.push({ ...diagnosis, code: change.suggestedCode });
  }

  if (unmatched.size > 0) {
    throw new CorrectedClaimError(
      `These suggested changes don't match any procedure or diagnosis on the claim: ${[...unmatched].join(", ")}.`
    );
  }
  if (serviceLines.length === 0) {
    throw new CorrectedClaimError("Applying these changes would leave the claim with no service lines.");
  }
  if (diagnoses.length === 0) {
    throw new CorrectedClaimError("Applying these changes would leave the claim with no diagnoses.");
  }

  return { ...claim, serviceLines, diagnoses };
}
