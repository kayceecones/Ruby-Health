// Loader for reference code sets dropped into reference/codes/.
//
// Accepts CSV, TSV, JSON, or a plain code-per-line list, detects the delimiter
// and column names, infers the code system from the code's shape, and returns
// one normalised, de-duplicated list.
//
// Two consumers, deliberately separate:
//   - validation: does this code exist? (deterministic, zero tokens)
//   - retrieval:  which codes might fit this encounter? (a short prompt block)
//
// Never load a whole code set into a prompt. ~74,000 ICD-10 codes is roughly
// 740k tokens per call, and burying the right code among 74,000 wrong ones
// makes the pick worse, not better.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CODES_DIR = path.join(__dirname, "codes");

// ICD-10-CM: a letter (never U), a digit, then alphanumerics, optionally
// dotted. CPT: five digits, or four digits plus F for Category II.
// HCPCS Level II: a letter followed by four digits.
const SHAPES = [
  // Checked before ICD-10: see AMBIGUOUS_SHAPE below.
  { type: "HCPCS", re: /^[A-V][0-9]{4}$/ },
  { type: "ICD-10", re: /^[A-TV-Z][0-9][0-9A-Z](\.?[0-9A-Z]{1,4})?$/ },
  { type: "CPT", re: /^([0-9]{5}|[0-9]{4}[FUMT])$/ },
];

// A letter followed by exactly four digits is both a valid HCPCS Level II code
// (G0439, annual wellness visit) and a valid dotless ICD-10-CM code (G0439 =
// G04.39). Shape cannot settle it, so a declared type column wins here and
// HCPCS is only the fallback guess.
const AMBIGUOUS_SHAPE = /^[A-V][0-9]{4}$/;

export function isAmbiguousShape(code) {
  return AMBIGUOUS_SHAPE.test(String(code ?? "").trim().toUpperCase());
}

export function inferCodeType(code) {
  const c = String(code ?? "").trim().toUpperCase();
  for (const { type, re } of SHAPES) if (re.test(c)) return type;
  return "UNKNOWN";
}

export function normalizeCode(code) {
  return String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Header names seen in real billing exports. Matched case- and
// punctuation-insensitively so "Long Description" and "long_description" agree.
const COLUMN_ALIASES = {
  code: ["code", "cpt", "icd", "icd10", "icd10cm", "hcpcs", "procedurecode", "diagnosiscode", "servicecode", "codevalue"],
  description: ["description", "desc", "longdescription", "shortdescription", "codedescription", "name", "label", "definition"],
  frequency: ["frequency", "freq", "count", "volume", "uses", "claims", "qty", "quantity", "n"],
  type: ["type", "codetype", "system", "codeset", "category"],
};

const slug = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

function resolveColumns(headers) {
  const slugged = headers.map(slug);
  const found = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const i = slugged.findIndex((h) => aliases.includes(h));
    if (i !== -1) found[field] = i;
  }
  return found;
}

// Minimal RFC4180-ish splitter: handles quoted fields and escaped quotes,
// which matter because code descriptions contain commas constantly.
export function splitRow(line, delimiter) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function detectDelimiter(sample) {
  const counts = [",", "\t", "|", ";"].map((d) => [d, (sample.match(new RegExp(`\\${d}`, "g")) || []).length]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : null;
}

const KNOWN_SYSTEMS = new Set(["ICD-10", "CPT", "HCPCS"]);

function normalizeDeclaredType(type) {
  const t = String(type ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!t) return null;
  if (t.startsWith("ICD")) return "ICD-10";
  if (t.startsWith("CPT")) return "CPT";
  if (t.startsWith("HCPCS")) return "HCPCS";
  return null;
}

function entry(code, description, type, frequency) {
  const inferred = inferCodeType(code);
  const declared = normalizeDeclaredType(type);

  // Shape wins when it is unambiguous -- exports mislabel columns far more
  // often than they mistype codes. Where the shape is genuinely ambiguous, a
  // declared type is the only real evidence, so it wins instead.
  let resolved;
  if (isAmbiguousShape(code) && declared && KNOWN_SYSTEMS.has(declared)) resolved = declared;
  else if (inferred !== "UNKNOWN") resolved = inferred;
  else resolved = declared || "UNKNOWN";

  return {
    code: String(code).trim().toUpperCase(),
    key: normalizeCode(code),
    description: String(description ?? "").trim(),
    type: resolved,
    frequency: Number.isFinite(Number(frequency)) && frequency !== "" && frequency != null ? Number(frequency) : null,
  };
}

export function parseCodeFile(contents, filename = "") {
  const trimmed = contents.trim();
  if (!trimmed) return [];

  // ---- JSON ----
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const data = JSON.parse(trimmed);
    const rows = Array.isArray(data) ? data : Array.isArray(data.codes) ? data.codes : [];
    return rows
      .map((r) => {
        if (typeof r === "string") return entry(r, "", null, null);
        const keys = Object.keys(r);
        const pick = (field) => {
          const k = keys.find((k2) => COLUMN_ALIASES[field].includes(slug(k2)));
          return k ? r[k] : undefined;
        };
        return entry(pick("code") ?? r.code, pick("description"), pick("type"), pick("frequency"));
      })
      .filter((e) => e.code);
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#"));
  if (lines.length === 0) return [];

  const delimiter = detectDelimiter(lines[0]);

  // ---- plain list, one code (optionally "CODE description") per line ----
  if (!delimiter) {
    return lines
      .map((line) => {
        const m = line.trim().match(/^(\S+)\s*(.*)$/);
        return m ? entry(m[1], m[2], null, null) : null;
      })
      .filter(Boolean)
      .filter((e) => e.code);
  }

  // ---- delimited ----
  const first = splitRow(lines[0], delimiter);
  const cols = resolveColumns(first);
  const hasHeader = cols.code !== undefined;

  // Without a recognisable header, assume the conventional column order.
  const idx = hasHeader ? cols : { code: 0, description: 1, frequency: 2 };
  const body = hasHeader ? lines.slice(1) : lines;

  return body
    .map((line) => {
      const f = splitRow(line, delimiter);
      return entry(f[idx.code], idx.description !== undefined ? f[idx.description] : "", idx.type !== undefined ? f[idx.type] : null, idx.frequency !== undefined ? f[idx.frequency] : null);
    })
    .filter((e) => e.code && e.key);
}

/**
 * Load every code file in reference/codes/ into one list.
 * Later duplicates lose, but contribute their description and frequency if the
 * earlier entry lacked them -- so a frequency export and a full code set
 * combine into richer entries than either alone.
 */
export async function loadCodeSet(dir = CODES_DIR) {
  let files;
  try {
    files = (await fs.readdir(dir)).filter((f) => /\.(csv|tsv|txt|json|psv)$/i.test(f)).sort();
  } catch {
    return { codes: [], byKey: new Map(), sources: [], warnings: ["reference/codes/ not found"] };
  }

  const byKey = new Map();
  const sources = [];
  const warnings = [];

  for (const file of files) {
    const raw = await fs.readFile(path.join(dir, file), "utf8");
    let parsed;
    try {
      parsed = parseCodeFile(raw, file);
    } catch (err) {
      warnings.push(`${file}: could not parse (${err.message})`);
      continue;
    }

    let added = 0;
    for (const e of parsed) {
      const existing = byKey.get(e.key);
      if (!existing) {
        byKey.set(e.key, { ...e, sources: [file] });
        added++;
      } else {
        if (!existing.description && e.description) existing.description = e.description;
        if (existing.frequency == null && e.frequency != null) existing.frequency = e.frequency;
        if (existing.type === "UNKNOWN" && e.type !== "UNKNOWN") existing.type = e.type;
        if (!existing.sources.includes(file)) existing.sources.push(file);
      }
    }

    const unknown = parsed.filter((e) => e.type === "UNKNOWN").length;
    sources.push({ file, parsed: parsed.length, added, unrecognisedShape: unknown });
    if (unknown > 0) {
      warnings.push(`${file}: ${unknown} of ${parsed.length} entries have a code shape matching no known system -- check the column mapping`);
    }
    if (parsed.length === 0) warnings.push(`${file}: parsed to zero entries`);
  }

  // Most-used first, so a truncated shortlist keeps the codes that matter.
  const codes = [...byKey.values()].sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0) || a.code.localeCompare(b.code));

  return { codes, byKey, sources, warnings };
}

/** Is this a real code? The validation half. */
export function isKnownCode(byKey, code) {
  return byKey.has(normalizeCode(code));
}
