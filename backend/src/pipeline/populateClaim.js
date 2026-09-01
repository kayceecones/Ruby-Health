// Deterministic claim population. No model call: given facts and codes, the
// claim that comes out is the same every time.

// CMS-1500 box 21 carries at most twelve diagnoses, pointered A through L.
const MAX_DIAGNOSES = 12;

export class ClaimError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaimError";
  }
}

function pointerLetter(index) {
  return String.fromCharCode(65 + index);
}

// "J02.9", "j029" and " J02.9 " all describe the same diagnosis; match on the
// bare alphanumerics so a formatting difference never breaks a link.
function normalizeCode(code) {
  return String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

/**
 * @param {object} facts
 * @param {array} codes
 * @param {object|null} [providerProfile] From providerProfiles.getProviderProfile().
 *   When null, the claim is populated with a clearly-labeled placeholder
 *   provider and a warning -- a claim never silently carries a fake NPI
 *   without saying so.
 */
export function populateClaim(facts, codes, providerProfile = null) {
  const diagnosisCodes = codes.filter((c) => c.codeType === "ICD-10");

  if (diagnosisCodes.length > MAX_DIAGNOSES) {
    throw new ClaimError(
      `A claim carries at most ${MAX_DIAGNOSES} diagnoses (pointers A-L); this draft has ${diagnosisCodes.length}. ` +
        `Remove the diagnoses that do not support a service line.`
    );
  }

  const diagnoses = diagnosisCodes.map((c, i) => ({
    pointer: pointerLetter(i),
    code: c.code,
    description: c.description,
  }));

  const pointerByCode = new Map();
  for (const d of diagnoses) {
    const key = normalizeCode(d.code);
    // First pointer wins, so a duplicated diagnosis resolves to one letter.
    if (key && !pointerByCode.has(key)) pointerByCode.set(key, d.pointer);
  }

  const warnings = [];

  const serviceLines = codes
    .filter((c) => c.codeType === "CPT")
    .map((c) => {
      // Each procedure links to the diagnoses that establish its medical
      // necessity -- a strep test is justified by the pharyngitis, not by
      // whichever diagnosis happened to sort first.
      const requested = Array.isArray(c.supportingDiagnoses) ? c.supportingDiagnoses : [];

      const resolved = [];
      const unresolved = [];
      for (const raw of requested) {
        const pointer = pointerByCode.get(normalizeCode(raw));
        if (!pointer) unresolved.push(raw);
        else if (!resolved.includes(pointer)) resolved.push(pointer);
      }

      if (resolved.length === 0) {
        warnings.push({
          code: "UNLINKED_SERVICE_LINE",
          line: c.code,
          message:
            `Service line ${c.code} has no supporting diagnosis. A payer will deny a service ` +
            `that nothing on the claim justifies.`,
        });
      }
      if (unresolved.length > 0) {
        warnings.push({
          code: "UNKNOWN_SUPPORTING_DIAGNOSIS",
          line: c.code,
          message:
            `Service line ${c.code} cites ${unresolved.join(", ")}, which is not among the ` +
            `claim's diagnoses. Add the diagnosis or correct the link.`,
        });
      }
      return {
        code: c.code,
        description: c.description,
        diagnosisPointers: resolved.join(""),
        units: 1,
      };
    });

  if (!providerProfile) {
    warnings.push({
      code: "NO_PROVIDER_PROFILE",
      message:
        "No provider profile is configured. This claim carries a placeholder NPI and will be rejected by a " +
        "real payer. Set up the provider's profile before submitting anything beyond a sandbox demo.",
    });
  }

  return {
    patient: {
      name: "Sample Patient (synthetic)",
      dob: "1990-01-01",
      sex: "U",
      memberId: "SAMPLE-0001",
    },
    // Hardwired for the MVP demo: both name and NPI are values Stedi's
    // sandbox actually accepts, not obviously-fake placeholders. This path
    // only runs when no provider profile is configured at all -- with
    // server.js seeding one on every boot, that should be rare, but if it's
    // ever hit, the claim still submits successfully rather than bouncing
    // on an invalid NPI or an implausible provider name.
    provider: providerProfile || {
      name: "Ruby Health Demo Practice",
      npi: "1999999984", // Stedi's published test NPI -- always valid in their sandbox
      address: "123 Main St, Sample City, ST 00000",
    },
    payer: {
      name: "Sample Payer Insurance",
      payerId: "00000",
    },
    dateOfService: new Date().toISOString().slice(0, 10),
    chiefComplaint: facts.chiefComplaint || "",
    medicalNecessityNotes: Array.isArray(facts.medicalNecessityLanguage)
      ? facts.medicalNecessityLanguage.join("\n")
      : "",
    diagnoses,
    serviceLines,
    warnings,
  };
}
