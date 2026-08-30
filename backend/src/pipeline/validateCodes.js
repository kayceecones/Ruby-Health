// Check suggested codes against a reference code set.
//
// WARNING-LEVEL ONLY, BY DESIGN. An unrecognised code is flagged for a
// reviewer, never removed from the claim.
//
// The reason is the reference set itself: the CMS Section 111 list currently in
// use is a Medicare Secondary Payer reporting list, not the general billing
// code set. It omits codes that are perfectly valid to bill -- Z23 (encounter
// for immunization) among them. Blocking on it would reject correct codes with
// total confidence, which is worse than not checking at all.
//
// This becomes a hard block only once a complete ICD-10-CM release is loaded.
// See reference/README.md.

import { normalizeCode } from "../../../reference/loadCodes.mjs";

export const VALIDATION = {
  KNOWN: "known", // present in the reference set
  UNRECOGNISED: "unrecognised", // absent -- worth a look, not necessarily wrong
  UNCHECKED: "unchecked", // no reference set covers this code system
};

/**
 * Annotate each suggestion with a validation verdict.
 *
 * @param {Array}  suggestions  code suggestions from the model
 * @param {object} codeIndex    { byKey: Map, coversTypes: Set } or null
 */
export function annotateValidation(suggestions, codeIndex) {
  const list = Array.isArray(suggestions) ? suggestions : [];
  const byKey = codeIndex?.byKey;
  const covers = codeIndex?.coversTypes;

  return list.map((s) => {
    // Only claim to have checked a code system the reference set actually
    // covers. Reporting "unrecognised" for a CPT code when no CPT set is
    // loaded would be a false alarm on every single procedure.
    if (!byKey || byKey.size === 0 || !covers?.has(s.codeType)) {
      return { ...s, validation: { status: VALIDATION.UNCHECKED, source: null } };
    }

    const known = byKey.has(normalizeCode(s.code));
    return {
      ...s,
      validation: {
        status: known ? VALIDATION.KNOWN : VALIDATION.UNRECOGNISED,
        source: codeIndex.source || "reference set",
      },
    };
  });
}

/** Suggestions a reviewer should look at first. */
export function unrecognisedCodes(annotated) {
  return annotated.filter((s) => s.validation?.status === VALIDATION.UNRECOGNISED).map((s) => s.code);
}
