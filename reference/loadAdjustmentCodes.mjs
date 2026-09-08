// Lookup for the reason codes a payer puts on an 835 remittance: CARC (why an
// amount was adjusted) and RARC (supplemental explanation).
//
// Unlike reference/codes/, this file is committed. Denial handling is useless
// without it -- a fresh clone or a deploy has to be able to say what CO-50
// means -- and a published reason-code list is not practice-specific data.
//
// Lookup only. What to *do* about a given category (correct the codes, appeal,
// bill the patient) is Ruby's judgement and lives in the pipeline, not here:
// the same seam the ICD-10 loader keeps between "is this a real code?" and
// "which codes fit this encounter?".

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ADJUSTMENT_CODES_FILE = path.join(__dirname, "adjustment-codes.json");

// A payer may write CARC 1 as "1" or "001", and group codes in either case.
// Normalising both ends means a leading zero never turns a known code into an
// unknown one.
export function normalizeReasonCode(code) {
  const raw = String(code ?? "").trim().toUpperCase();
  if (!raw) return "";
  return /^[0-9]+$/.test(raw) ? String(parseInt(raw, 10)) : raw;
}

/**
 * @returns {Promise<{carc: Map, rarc: Map, groupCodes: object, loaded: boolean}>}
 *   Missing or unreadable file returns empty maps rather than throwing --
 *   every unknown code then degrades to "reported raw", which is the same
 *   thing that happens to a code the list simply doesn't carry.
 */
export async function loadAdjustmentCodes(file = ADJUSTMENT_CODES_FILE) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    const carc = new Map((parsed.carc || []).map((e) => [normalizeReasonCode(e.code), e]));
    const rarc = new Map((parsed.rarc || []).map((e) => [normalizeReasonCode(e.code), e]));
    return { carc, rarc, groupCodes: parsed.groupCodes || {}, loaded: true };
  } catch {
    return { carc: new Map(), rarc: new Map(), groupCodes: {}, loaded: false };
  }
}

// Never invent a meaning for a code we don't carry. A confidently wrong
// explanation of why a claim was denied is worse than "unrecognised" --
// someone acts on it, and the money is real.
function describe(index, code, kind) {
  const key = normalizeReasonCode(code);
  const hit = index.get(key);
  if (!hit) {
    return { code: key, kind, description: "", category: "unknown", known: false };
  }
  return { code: hit.code, kind, description: hit.description, category: hit.category, known: true };
}

export function describeCarc(codes, code) {
  return describe(codes.carc, code, "CARC");
}

export function describeRarc(codes, code) {
  return describe(codes.rarc, code, "RARC");
}

/**
 * Group code semantics -- crucially, whether an amount can be billed to the
 * patient. Getting this wrong in either direction is a real problem: billing a
 * contractual write-off is a contract violation, and writing off patient
 * responsibility is unbilled revenue.
 */
export function describeGroupCode(codes, code) {
  const key = String(code ?? "").trim().toUpperCase();
  const hit = codes.groupCodes[key];
  if (!hit) return { code: key, name: "", meaning: "", billable: false, known: false };
  return { code: key, ...hit, known: true };
}
