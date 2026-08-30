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
import { usageTotals } from "./usage.js";
import {
  getProviderProfile,
  upsertProviderProfile,
  listProviderProfiles,
  ProviderProfileError,
  DEFAULT_PROVIDER_ID,
} from "./providerProfiles.js";

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

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(FRONTEND_DIR));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(API_KEY), model: MODEL, utilityModel: UTILITY_MODEL });
});

app.post("/api/extract", async (req, res) => {
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
    const facts = await extractClinicalFacts(anthropic, MODEL, transcript);

    // Presented as direct quotation and carried into the claim as the
    // justification for care, so it is checked before a reviewer sees it.
    facts.medicalNecessityGrounding = verifyNecessityQuotes(facts, transcript);

    res.json({ facts });
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
  const { facts } = req.body || {};

  if (!facts || typeof facts !== "object") {
    return res.status(400).json({ error: "Request body must include a 'facts' object (the extraction output)." });
  }

  if (!anthropic) {
    return res.status(500).json({
      error: "ANTHROPIC_API_KEY is not configured on the server. Add it to backend/.env and restart.",
    });
  }

  try {
    const suggestions = await suggestCodes(anthropic, MODEL, facts);
    res.json({ suggestions });
  } catch (err) {
    console.error("Code suggestion failed:", err);
    res.status(502).json({ error: "Code suggestion failed. See server logs for details." });
  }
});

app.post("/api/populate-claim", (req, res) => {
  const { facts, codes, providerId } = req.body || {};

  if (!facts || typeof facts !== "object") {
    return res.status(400).json({ error: "Request body must include a 'facts' object (the extraction output)." });
  }
  if (!Array.isArray(codes)) {
    return res.status(400).json({ error: "Request body must include a 'codes' array (the code suggestions)." });
  }

  try {
    const providerProfile = getProviderProfile(providerId || DEFAULT_PROVIDER_ID);
    const claim = populateClaim(facts, codes, providerProfile);
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

app.post("/api/submit-claim", async (req, res) => {
  const { claim } = req.body || {};

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
