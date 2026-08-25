import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { extractClinicalFacts } from "./pipeline/extract.js";
import { suggestCodes } from "./pipeline/suggestCodes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = path.join(__dirname, "..", "..", "frontend");

const PORT = process.env.PORT || 3000;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const API_KEY = process.env.ANTHROPIC_API_KEY;

const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(FRONTEND_DIR));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, hasApiKey: Boolean(API_KEY) });
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
    res.json({ facts });
  } catch (err) {
    console.error("Extraction failed:", err);
    res.status(502).json({ error: "Extraction failed. See server logs for details." });
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

app.listen(PORT, () => {
  console.log(`Ruby Health demo backend listening on http://localhost:${PORT}`);
  if (!API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. /api/extract will return an error until it is configured.");
  }
});
