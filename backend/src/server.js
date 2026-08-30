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
import { submitClaim, SubmissionError } from "./pipeline/submitClaim.js";
import { verifyNecessityQuotes } from "./pipeline/verifyQuotes.js";
import { annotateValidation, unrecognisedCodes } from "./pipeline/validateCodes.js";
import { usageTotals } from "./usage.js";
import { loadCodeSet } from "../../reference/loadCodes.mjs";

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

const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

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
  });
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
    const suggested = await suggestCodes(anthropic, MODEL, facts);
    const suggestions = annotateValidation(suggested, codeIndex);

    const unrecognised = unrecognisedCodes(suggestions);
    if (unrecognised.length > 0) {
      console.log(JSON.stringify({ type: "validation", unrecognised }));
    }

    res.json({ suggestions });
  } catch (err) {
    console.error("Code suggestion failed:", err);
    res.status(502).json({ error: "Code suggestion failed. See server logs for details." });
  }
});

app.post("/api/populate-claim", (req, res) => {
  const { facts, codes } = req.body || {};

  if (!facts || typeof facts !== "object") {
    return res.status(400).json({ error: "Request body must include a 'facts' object (the extraction output)." });
  }
  if (!Array.isArray(codes)) {
    return res.status(400).json({ error: "Request body must include a 'codes' array (the code suggestions)." });
  }

  try {
    const claim = populateClaim(facts, codes);
    res.json({ claim });
  } catch (err) {
    if (err instanceof ClaimError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Claim population failed:", err);
    res.status(500).json({ error: "Claim population failed. See server logs for details." });
  }
});

app.post("/api/submit-claim", (req, res) => {
  const { claim } = req.body || {};

  try {
    const result = submitClaim(claim);
    res.json({ result });
  } catch (err) {
    if (err instanceof SubmissionError) {
      return res.status(400).json({ error: err.message });
    }
    console.error("Claim submission failed:", err);
    res.status(500).json({ error: "Claim submission failed. See server logs for details." });
  }
});

app.get("/api/usage", (_req, res) => {
  res.json(usageTotals());
});

app.listen(PORT, () => {
  console.log(`Ruby Health demo backend listening on http://localhost:${PORT}`);
  console.log(`Claim path model: ${MODEL} | transcript cleanup: ${UTILITY_MODEL}`);
  if (!API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. /api/extract will return an error until it is configured.");
  }
});
