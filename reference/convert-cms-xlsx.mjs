// Convert the CMS Section 111 ICD-10 workbooks into the CSV shape the loader
// reads.
//
//   node reference/convert-cms-xlsx.mjs <valid.xlsx> <excluded.xlsx>
//
// Source: CMS Section 111 Medicare Secondary Payer reporting reference files.
// The generated CSVs are gitignored -- they are large and re-derivable, so the
// script is the artefact worth keeping, not its output.
//
// Note on what these lists mean: the "valid" sheet is the FY2027 ICD-10-CM set
// and is the right basis for validating that a code exists. The "excluded"
// sheets are specific to Section 111 reporting -- codes CMS will not accept for
// MSP purposes -- which is narrower than "do not bill this". They are written
// to a separate file so the two are never conflated.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let XLSX;
try {
  XLSX = require("xlsx");
} catch {
  console.error(
    "This script needs a spreadsheet reader.\n" +
      "Either `npm i -D xlsx` at the repo root, or convert the sheets to CSV by hand:\n" +
      "  valid    -> reference/codes/icd10-valid-fy2027.csv   (code,description,type)\n" +
      "  excluded -> reference/section111-excluded.csv        (code,description,excluded_list)"
  );
  process.exit(1);
}

const [validPath, excludedPath] = process.argv.slice(2);
if (!validPath) {
  console.error("Usage: node reference/convert-cms-xlsx.mjs <valid.xlsx> [excluded.xlsx]");
  process.exit(1);
}

const OUT_CODES = path.join(import.meta.dirname, "codes");
fs.mkdirSync(OUT_CODES, { recursive: true });

const csvCell = (v) => {
  const s = String(v ?? "").trim();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRow = (cells) => cells.map(csvCell).join(",");

// ---- valid codes ----
{
  const wb = XLSX.readFile(validPath);
  const sheet = wb.SheetNames.find((n) => /valid/i.test(n)) || wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, blankrows: false }).slice(1);

  const lines = ["code,description,type"];
  for (const r of rows) {
    const code = r[0];
    if (!code) continue;
    // Prefer the long description; fall back to the short one.
    lines.push(csvRow([String(code).trim(), r[2] || r[1] || "", "ICD-10"]));
  }
  const out = path.join(OUT_CODES, "icd10-valid-fy2027.csv");
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`${lines.length - 1} valid codes -> ${path.relative(process.cwd(), out)}`);
}

// ---- excluded codes, kept out of reference/codes/ so the loader ignores them ----
if (excludedPath) {
  const wb = XLSX.readFile(excludedPath);
  const lines = ["code,description,excluded_list"];
  for (const name of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false }).slice(1);
    for (const r of rows) {
      if (!r[0]) continue;
      lines.push(csvRow([String(r[0]).trim(), r[1] || "", name]));
    }
  }
  const out = path.join(import.meta.dirname, "section111-excluded.csv");
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`${lines.length - 1} excluded codes -> ${path.relative(process.cwd(), out)}`);
}
