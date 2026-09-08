import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { extractClinicalFacts } from "./pipeline/extract.js";
import { cleanupTranscript } from "./pipeline/cleanupTranscript.js";
import { suggestCodes } from "./pipeline/suggestCodes.js";
import { populateClaim, ClaimError } from "./pipeline/populateClaim.js";
import { verifyNecessityQuotes } from "./pipeline/verifyQuotes.js";
import { buildStediClaim, StediMappingError } from "./pipeline/buildStediClaim.js";
import { submitToStedi, StediSubmissionError } from "./pipeline/submitToStedi.js";
import { annotateValidation, unrecognisedCodes } from "./pipeline/validateCodes.js";
import { usageTotals } from "./usage.js";
import { loadCodeSet } from "../../reference/loadCodes.mjs";
import { createNotionRepositoryFromEnv, NotionRepositoryError } from "./repository/index.js";
import {
  getProviderProfile,
  upsertProviderProfile,
  listProviderProfiles,
  ProviderProfileError,
  DEFAULT_PROVIDER_ID,
} from "./providerProfiles.js";
import { DEMO_PROVIDER_PROFILE } from "../scripts/seed-provider-profile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");

const PORT = process.env.PORT || 3000;
// The claim path -- extraction and coding -- runs on the strongest model:
// coding judgment is the product, and a denied claim costs a practice far more
// than the model call that produced it.
const MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";

// Transcript cleanup is punctuation repair, not judgment, and it regenerates the
// whole transcript as output tokens. It stays on a cheap model until it is
// retired from the claim path entirely.
const UTILITY_MODEL = process.env.ANTHROPIC_UTILITY_MODEL || "claude-haiku-4-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Stedi sandbox credentials -- separate from the Anthropic key, kept out of
// the repo the same way. A test-mode key only reaches Stedi's sandbox network.
const STEDI_API_KEY = process.env.STEDI_API_KEY;

const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

// providerProfiles.js is a JSON file on disk -- fine locally, but Render's
// disk is ephemeral, so a profile seeded by hand (npm run seed:provider)
// does not survive a redeploy or a free-tier spin-down/spin-up. Seeding the
// demo profile here instead, on every boot, means the live service always
// has a real NPI to submit with -- not the 0000000000 placeholder Stedi
// rejects -- without a manual step that's easy to forget after a deploy.
if (!getProviderProfile(DEFAULT_PROVIDER_ID)) {
  upsertProviderProfile(DEFAULT_PROVIDER_ID, DEMO_PROVIDER_PROFILE);
  console.log(`Seeded demo provider profile for '${DEFAULT_PROVIDER_ID}' (none found on disk at boot).`);
}

// Notion-backed persistence -- optional at boot, same as the reference code
// set. A fresh clone (or a deploy) with no NOTION_* env vars still runs the
// claim pipeline exactly as before; only the New Claim intake screen and
// encounter/artifact persistence are unavailable until it's configured.
let repository = null;
try {
  repository = createNotionRepositoryFromEnv();
} catch (err) {
  console.warn("Notion repository not configured -- patient/case persistence disabled:", err.message);
}

// Loaded once at boot. Absent or empty is fine: validation reports "unchecked"
// rather than failing, so a fresh clone with no reference files still runs.
let codeIndex = null;
loadCodeSet()
  .then(({ codes, byKey, sources }) => {
    if (codes.length === 0) {
      console.warn("No reference code set found -- code validation is disabled. See reference/README.md.");
      return;
    }
    const coversTypes = new Set(codes.map((c) => c.type));
    codeIndex = { byKey, coversTypes, source: sources.map((s2) => s2.file).join(", "), size: codes.length };
    console.log(`Reference code set: ${codes.length} codes covering ${[...coversTypes].join(", ")}`);
    console.warn(
      "NOTE: the loaded set is not a complete billing code set. Validation is " +
        "warning-level only and never blocks a code. Demo use only."
    );
  })
  .catch((err) => console.warn("Could not load reference code set:", err.message));

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(FRONTEND_DIR));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(API_KEY),
    model: MODEL,
    utilityModel: UTILITY_MODEL,
    codeValidation: codeIndex
      ? { enabled: true, codes: codeIndex.size, covers: [...codeIndex.coversTypes], blocking: false }
      : { enabled: false },
    persistence: { enabled: Boolean(repository) },
  });
});

function requireRepository(res) {
  if (repository) return true;
  res.status(500).json({
    error: "Notion repository is not configured on the server. Add NOTION_* vars to backend/.env and restart.",
  });
  return false;
}

// Best-effort: a persistence hiccup shouldn't take down a pipeline stage the
// provider is actively watching. Logged, not surfaced, the same way code
// validation warns instead of blocking.
async function persistArtifact(encounterId, stage, content) {
  if (!repository || !encounterId) return;
  try {
    await repository.createArtifact({ encounterId, stage, content, createdBy: "system" });
  } catch (err) {
    console.error(`Persisting '${stage}' artifact for encounter '${encounterId}' failed:`, err);
  }
}

// A provider recording a visit shouldn't have to know who the patient is
// before they can start talking -- extraction can run, and the encounter
// still needs to land somewhere real. Every such encounter files under one
// shared placeholder Patient, in its own Case titled from the chief
// complaint, so it's a real findable record instead of being silently lost.
const UNIDENTIFIED_PATIENT_NAME = "Unidentified Patient";
const UNIDENTIFIED_PATIENT_DOB = "1900-01-01";
let unidentifiedPatientCache = null;

async function getOrCreateUnidentifiedPatient() {
  if (unidentifiedPatientCache) return unidentifiedPatientCache;
  const patients = await repository.listPatients();
  const existing = patients.find((p) => p.name === UNIDENTIFIED_PATIENT_NAME);
  unidentifiedPatientCache =
    existing || (await repository.createPatient({ name: UNIDENTIFIED_PATIENT_NAME, dateOfBirth: UNIDENTIFIED_PATIENT_DOB }));
  return unidentifiedPatientCache;
}

function deriveUnidentifiedCaseTitle(facts) {
  const chiefComplaint = ((facts && facts.chiefComplaint) || "").trim();
  return chiefComplaint ? `${chiefComplaint} - unidentified patient` : "Encounter - unidentified patient";
}

// Best-effort, same as persistArtifact: a provisioning hiccup shouldn't
// block returning facts the extraction call already succeeded at.
async function autoProvisionEncounter(facts) {
  if (!repository) return null;
  try {
    const patient = await getOrCreateUnidentifiedPatient();
    const title = deriveUnidentifiedCaseTitle(facts);
    const createdCase = await repository.createCase({ patientId: patient.patientId, title });
    const occurredAt = new Date().toISOString().slice(0, 10);
    const encounter = await repository.createEncounter({ caseId: createdCase.caseId, occurredAt });
    return { patient, case: createdCase, encounter };
  } catch (err) {
    console.error("Auto-provisioning an unidentified-patient encounter failed:", err);
    return null;
  }
}

// Encounters are optional at the repository level (see NotionRepository's
// constructor), so anything computing "last activity" or a visit count from
// them needs to degrade to "no encounters" rather than fail outright.
async function listEncountersForCaseSafe(caseId) {
  try {
    return await repository.listEncountersForCase(caseId);
  } catch (err) {
    if (err instanceof NotionRepositoryError) return [];
    throw err;
  }
}

function latestTimestamp(timestamps) {
  const present = timestamps.filter(Boolean);
  return present.length ? present.sort().at(-1) : null;
}

app.get("/api/patients", async (_req, res) => {
  if (!requireRepository(res)) return;
  try {
    const patients = await repository.listPatients();
    // The History patient list needs open-case count and last-activity per
    // row; every other caller of this endpoint (patient search in the New
    // Claim intake step) just ignores the extra fields.
    const enriched = await Promise.all(
      patients.map(async (patient) => {
        const cases = await repository.listCasesForPatient(patient.patientId);
        const encounterLists = await Promise.all(cases.map((c) => listEncountersForCaseSafe(c.caseId)));
        const encounters = encounterLists.flat();
        return {
          ...patient,
          openCaseCount: cases.filter((c) => c.status === "open").length,
          lastActivity: latestTimestamp([
            ...encounters.map((e) => e.createdAt || e.occurredAt),
            ...cases.map((c) => c.openedAt),
          ]),
        };
      })
    );
    res.json({ patients: enriched });
  } catch (err) {
    console.error("Listing patients failed:", err);
    res.status(502).json({ error: "Listing patients failed. See server logs for details." });
  }
});

app.post("/api/patients", async (req, res) => {
  if (!requireRepository(res)) return;
  const { name, dateOfBirth } = req.body || {};

  if (!name || !dateOfBirth) {
    return res.status(400).json({ error: "Request body must include 'name' and 'dateOfBirth'." });
  }

  try {
    const patient = await repository.createPatient({ name, dateOfBirth });
    res.json({ patient });
  } catch (err) {
    console.error("Creating patient failed:", err);
    res.status(502).json({ error: "Creating patient failed. See server logs for details." });
  }
});

// The History activity view's data source: recent encounters and recently
// submitted claims, newest first, across every patient. There's no single
// Notion query for "everything recent" -- foreign keys are plain-text IDs,
// not Notion relations (see NotionRepository.js), so this composes the
// existing per-parent list methods instead of adding Notion-specific query
// logic. Fine at demo volume; a Postgres repository would answer this with
// one indexed query instead.
app.get("/api/activity", async (req, res) => {
  if (!requireRepository(res)) return;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  try {
    const patients = await repository.listPatients();
    const patientsById = new Map(patients.map((p) => [p.patientId, p]));

    const caseLists = await Promise.all(patients.map((p) => repository.listCasesForPatient(p.patientId)));
    const cases = caseLists.flat();
    const casesById = new Map(cases.map((c) => [c.caseId, c]));

    const encounterLists = await Promise.all(cases.map((c) => repository.listEncountersForCase(c.caseId)));
    const encounters = encounterLists.flat();
    const encountersById = new Map(encounters.map((e) => [e.encounterId, e]));

    // Claims require the claims data source to be configured, unlike
    // patients/cases/encounters -- degrade to "no claim activity" rather
    // than failing the whole feed when it isn't.
    let claims = [];
    try {
      const claimLists = await Promise.all(encounters.map((e) => repository.listClaimsForEncounter(e.encounterId)));
      claims = claimLists.flat();
    } catch (err) {
      if (!(err instanceof NotionRepositoryError)) throw err;
    }

    const encounterItems = encounters.map((e) => ({
      type: "encounter",
      id: e.encounterId,
      status: e.status,
      timestamp: e.createdAt || e.occurredAt,
      patientName: patientsById.get(e.patientId)?.name || e.patientId,
      caseTitle: casesById.get(e.caseId)?.title || e.caseId,
    }));

    const claimItems = claims.map((c) => {
      const encounter = encountersById.get(c.encounterId);
      const patient = encounter ? patientsById.get(encounter.patientId) : null;
      return {
        type: "claim",
        id: c.claimId,
        status: c.status,
        timestamp: c.submittedAt || c.createdAt,
        patientName: patient?.name || null,
        payerName: c.payerName,
      };
    });

    const activity = [...encounterItems, ...claimItems]
      .filter((item) => item.timestamp)
      .sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""))
      .slice(0, limit);

    res.json({ activity });
  } catch (err) {
    console.error("Building activity feed failed:", err);
    res.status(502).json({ error: "Building activity feed failed. See server logs for details." });
  }
});

app.get("/api/patients/:patientId/cases", async (req, res) => {
  if (!requireRepository(res)) return;
  try {
    const cases = await repository.listCasesForPatient(req.params.patientId);
    // The History patient view needs a visit count and last-activity per
    // case row; the New Claim intake step's case picker ignores the extras.
    const enriched = await Promise.all(
      cases.map(async (c) => {
        const encounters = await listEncountersForCaseSafe(c.caseId);
        return {
          ...c,
          visitCount: encounters.length,
          lastActivity: latestTimestamp([...encounters.map((e) => e.createdAt || e.occurredAt), c.openedAt]),
        };
      })
    );
    res.json({ cases: enriched });
  } catch (err) {
    console.error("Listing cases failed:", err);
    res.status(502).json({ error: "Listing cases failed. See server logs for details." });
  }
});

// The History case view's encounter list -- chronological, per build-order
// step 8. listEncountersForCase already sorts oldest-first (see
// NotionRepository.js); this is a thin wrapper, same shape as the other
// GET endpoints above.
app.get("/api/cases/:caseId/encounters", async (req, res) => {
  if (!requireRepository(res)) return;
  try {
    const encounters = await repository.listEncountersForCase(req.params.caseId);
    res.json({ encounters });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Listing encounters failed:", err);
    res.status(502).json({ error: "Listing encounters failed. See server logs for details." });
  }
});

// Build-order step 9: the History encounter view reads this to show the
// 4-tab UI in read mode, against what was actually persisted, instead of
// running the live pipeline. Returns every version of every stage -- the
// frontend picks the latest per stage for now; step 10's version-history
// disclosure needs the same data, so this endpoint doesn't change then.
app.get("/api/encounters/:encounterId/artifacts", async (req, res) => {
  if (!requireRepository(res)) return;
  try {
    const history = await repository.getArtifactHistory(req.params.encounterId);
    res.json({ history });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Loading artifact history failed:", err);
    res.status(502).json({ error: "Loading artifact history failed. See server logs for details." });
  }
});

app.post("/api/cases", async (req, res) => {
  if (!requireRepository(res)) return;
  const { patientId, title } = req.body || {};

  if (!patientId || !title) {
    return res.status(400).json({ error: "Request body must include 'patientId' and 'title'." });
  }

  try {
    const createdCase = await repository.createCase({ patientId, title });
    res.json({ case: createdCase });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Creating case failed:", err);
    res.status(502).json({ error: "Creating case failed. See server logs for details." });
  }
});

app.post("/api/encounters", async (req, res) => {
  if (!requireRepository(res)) return;
  const { caseId } = req.body || {};

  if (!caseId) {
    return res.status(400).json({ error: "Request body must include 'caseId'." });
  }

  try {
    const occurredAt = new Date().toISOString().slice(0, 10);
    const encounter = await repository.createEncounter({ caseId, occurredAt });
    res.json({ encounter });
  } catch (err) {
    if (err instanceof NotionRepositoryError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Creating encounter failed:", err);
    res.status(502).json({ error: "Creating encounter failed. See server logs for details." });
  }
});

app.post("/api/extract", async (req, res) => {
  const { transcript, encounterId } = req.body || {};

  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'transcript' string." });
  }

  if (!anthropic) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  try {
    const facts = await extractClinicalFacts(anthropic, MODEL, transcript);

    // Presented as direct quotation and carried into the claim as the
    // justification for care, so it is checked before a reviewer sees it.
    facts.medicalNecessityGrounding = verifyNecessityQuotes(facts, transcript);

    let effectiveEncounterId = encounterId;
    let autoProvisioned = null;
    if (!effectiveEncounterId) {
      autoProvisioned = await autoProvisionEncounter(facts);
      if (autoProvisioned) effectiveEncounterId = autoProvisioned.encounter.encounterId;
    }

    await persistArtifact(effectiveEncounterId, "transcript", { transcript });
    await persistArtifact(effectiveEncounterId, "facts", facts);

    res.json({ facts, encounterId: effectiveEncounterId || null, autoProvisioned });
  } catch (err) {
    console.error("Extraction failed:", err);
    res.status(502).json({ error: "Extraction failed. See server logs for details." });
  }
});

app.post("/api/cleanup-transcript", async (req, res) => {
  const { transcript } = req.body || {};

  if (typeof transcript !== "string" || transcript.trim().length === 0) {
    return res.status(400).json({ error: "Request body must include a non-empty 'transcript' string." });
  }

  if (!anthropic) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  try {
    const { cleanedTranscript, summary } = await cleanupTranscript(anthropic, UTILITY_MODEL, transcript);
    res.json({ cleanedTranscript, summary });
  } catch (err) {
    console.error("Transcript cleanup failed:", err);
    res.status(502).json({ error: "Transcript cleanup failed. See server logs for details." });
  }
});

app.post("/api/suggest-codes", async (req, res) => {
  const { facts, encounterId } = req.body || {};

  if (!facts || typeof facts !== "object") {
    return res.status(400).json({ error: "Request body must include a 'facts' object (the extraction output)." });
  }

  if (!anthropic) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  try {
    const suggested = await suggestCodes(anthropic, MODEL, facts);
    const suggestions = annotateValidation(suggested, codeIndex);

    const unrecognised = unrecognisedCodes(suggestions);
    if (unrecognised.length > 0) {
      console.log(JSON.stringify({ type: "validation", unrecognised }));
    }

    await persistArtifact(encounterId, "codes", suggestions);

    res.json({ suggestions });
  } catch (err) {
    console.error("Code suggestion failed:", err);
    res.status(502).json({ error: "Code suggestion failed. See server logs for details." });
  }
});

app.post("/api/populate-claim", async (req, res) => {
  const { facts, codes, providerId, encounterId } = req.body || {};

  if (!facts || typeof facts !== "object") {
    return res.status(400).json({ error: "Request body must include a 'facts' object (the extraction output)." });
  }
  if (!Array.isArray(codes)) {
    return res.status(400).json({ error: "Request body must include a 'codes' array (the code suggestions)." });
  }

  try {
    const providerProfile = getProviderProfile(providerId || DEFAULT_PROVIDER_ID);
    const claim = populateClaim(facts, codes, providerProfile);
    await persistArtifact(encounterId, "claim", claim);
    res.json({ claim });
  } catch (err) {
    if (err instanceof ClaimError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Claim population failed:", err);
    res.status(500).json({ error: "Claim population failed. See server logs for details." });
  }
});

app.get("/api/usage", (_req, res) => {
  res.json(usageTotals());
});

app.get("/api/provider-profile", (req, res) => {
  const providerId = req.query.providerId || DEFAULT_PROVIDER_ID;
  const profile = getProviderProfile(providerId);
  res.json({ providerId, profile }); // profile is null if none is configured yet
});

app.get("/api/provider-profiles", (_req, res) => {
  res.json({ providerIds: listProviderProfiles() });
});

app.post("/api/provider-profile", (req, res) => {
  const { providerId, profile } = req.body || {};

  if (!profile || typeof profile !== "object") {
    return res.status(400).json({ error: "Request body must include a 'profile' object." });
  }

  try {
    const saved = upsertProviderProfile(providerId || DEFAULT_PROVIDER_ID, profile);
    res.json({ providerId: providerId || DEFAULT_PROVIDER_ID, profile: saved });
  } catch (err) {
    if (err instanceof ProviderProfileError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Saving provider profile failed:", err);
    res.status(500).json({ error: "Failed to save provider profile." });
  }
});

// Best-effort, same as persistArtifact: recording that a claim was actually
// submitted is what makes it show up in the History activity view, but a
// failure here shouldn't turn a successful Stedi submission into an error
// response. Requires the claim-stage artifact to already be persisted (it
// is, by /api/populate-claim) since Claim rows point at it.
async function persistSubmittedClaim(encounterId, claim) {
  if (!repository || !encounterId) return;
  try {
    const artifact = await repository.getLatestArtifact(encounterId, "claim");
    if (!artifact) return;
    const created = await repository.createClaim({
      encounterId,
      artifactId: artifact.artifactId,
      claimType: "original",
      payerName: claim.payer?.name || "Unknown payer",
      memberId: claim.patient?.memberId || "Unknown member",
    });
    await repository.updateClaimStatus(created.claimId, "submitted");
  } catch (err) {
    console.error(`Persisting submitted claim for encounter '${encounterId}' failed:`, err);
  }
}

app.post("/api/submit-claim", async (req, res) => {
  const { claim, encounterId } = req.body || {};

  if (!claim || typeof claim !== "object") {
    return res.status(400).json({ error: "Request body must include a 'claim' object (the populated claim)." });
  }

  if (!STEDI_API_KEY) {
    return res.status(500).json({
      error: "STEDI_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  let stediClaim;
  try {
    stediClaim = buildStediClaim(claim);
  } catch (err) {
    if (err instanceof StediMappingError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Stedi claim mapping failed:", err);
    return res.status(500).json({ error: "Failed to map claim for Stedi submission." });
  }

  try {
    const stediResponse = await submitToStedi(stediClaim, STEDI_API_KEY);
    await persistSubmittedClaim(encounterId, claim);
    res.json({ stediClaim, stediResponse });
  } catch (err) {
    if (err instanceof StediSubmissionError) {
      console.error("Stedi rejected submission:", JSON.stringify(err.details));
      return res.status(502).json({ error: err.message, details: err.details, stediClaim });
    }
    console.error("Stedi submission failed:", err);
    res.status(502).json({ error: "Stedi submission failed. See server logs for details.", stediClaim });
  }
});

app.listen(PORT, () => {
  console.log(`Ruby Health demo backend listening on http://localhost:${PORT}`);
  console.log(`Claim path model: ${MODEL} | transcript cleanup: ${UTILITY_MODEL}`);
  if (!API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. /api/extract will return an error until it is configured.");
  }
});
