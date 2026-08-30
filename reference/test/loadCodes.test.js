import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parseCodeFile, loadCodeSet, inferCodeType, isKnownCode, splitRow, isAmbiguousShape } from "../loadCodes.mjs";

test("infers the code system from the code's shape", () => {
  assert.equal(inferCodeType("J02.9"), "ICD-10");
  assert.equal(inferCodeType("E11.42"), "ICD-10");
  assert.equal(inferCodeType("Z23"), "ICD-10");
  assert.equal(inferCodeType("S93.401A"), "ICD-10");
  assert.equal(inferCodeType("87880"), "CPT");
  assert.equal(inferCodeType("99213"), "CPT");
  assert.equal(inferCodeType("G0439"), "HCPCS");
  assert.equal(inferCodeType("banana"), "UNKNOWN");
});

test("a letter plus four digits is ambiguous, so a declared type decides it", () => {
  // G0439 is a real HCPCS code (annual wellness visit) AND a valid dotless
  // ICD-10 code (G04.39). Shape cannot tell them apart.
  assert.equal(isAmbiguousShape("G0439"), true);
  assert.equal(isAmbiguousShape("J02.9"), false);
  assert.equal(isAmbiguousShape("87880"), false);

  const declaredIcd = parseCodeFile("code,description,type\nG0439,Other encephalitis,ICD-10\n");
  assert.equal(declaredIcd[0].type, "ICD-10", "the column is the only evidence available");

  const declaredHcpcs = parseCodeFile("code,description,type\nG0439,Annual wellness visit,HCPCS\n");
  assert.equal(declaredHcpcs[0].type, "HCPCS");

  const undeclared = parseCodeFile("code,description\nG0439,Annual wellness visit\n");
  assert.equal(undeclared[0].type, "HCPCS", "falls back to the likelier reading of that shape");
});

test("reads a CSV with a header in any casing or punctuation", () => {
  const rows = parseCodeFile(
    "Code,Long Description,Count\nJ02.9,\"Acute pharyngitis, unspecified\",412\n87880,Strep A rapid test,388\n"
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, "J02.9");
  assert.equal(rows[0].description, "Acute pharyngitis, unspecified", "quoted commas must survive");
  assert.equal(rows[0].frequency, 412);
  assert.equal(rows[0].type, "ICD-10");
  assert.equal(rows[1].type, "CPT");
});

test("handles tab-separated files", () => {
  const rows = parseCodeFile("code\tdescription\nE11.9\tType 2 diabetes without complications\n");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].code, "E11.9");
  assert.equal(rows[0].description, "Type 2 diabetes without complications");
});

test("falls back to conventional column order when there is no header", () => {
  const rows = parseCodeFile("J02.9,Acute pharyngitis,10\nZ23,Immunization,4\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, "J02.9");
  assert.equal(rows[0].frequency, 10);
});

test("reads a plain one-code-per-line list", () => {
  const rows = parseCodeFile("J02.9 Acute pharyngitis\nZ23 Encounter for immunization\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[1].code, "Z23");
  assert.equal(rows[1].description, "Encounter for immunization");
});

test("reads JSON, as an array of objects or of bare strings", () => {
  const objects = parseCodeFile('[{"code":"J02.9","description":"Pharyngitis","count":7}]');
  assert.equal(objects[0].frequency, 7);

  const strings = parseCodeFile('["J02.9","87880"]');
  assert.equal(strings.length, 2);
  assert.equal(strings[1].type, "CPT");
});

test("ignores comments and blank lines", () => {
  const rows = parseCodeFile("# exported 2026-08-28\n\nJ02.9,Pharyngitis\n\n");
  assert.equal(rows.length, 1);
});

test("a code's shape overrides a mislabelled type column", () => {
  const rows = parseCodeFile("code,description,type\n87880,Strep test,ICD-10\n");
  assert.equal(rows[0].type, "CPT", "the column said ICD-10; the code is plainly a CPT");
});

test("splitRow handles escaped quotes inside a quoted field", () => {
  assert.deepEqual(splitRow('a,"say ""hi"", ok",c', ","), ["a", 'say "hi", ok', "c"]);
});

// ---- directory loading ----

async function withTempDir(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rh-codes-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), body);
    }
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("merges several files, enriching entries rather than discarding them", async () => {
  await withTempDir(
    {
      // A frequency export: counts, no descriptions.
      "practice-history.csv": "code,count\nJ02.9,412\nE11.9,300\n",
      // A code set: descriptions, no counts.
      "icd10-subset.csv": "code,description\nJ02.9,Acute pharyngitis unspecified\nZ23,Encounter for immunization\n",
    },
    async (dir) => {
      const { codes, byKey, warnings } = await loadCodeSet(dir);

      assert.equal(codes.length, 3, "J02.9 appears in both files but is one entry");

      const j029 = byKey.get("J029");
      assert.equal(j029.frequency, 412, "frequency from the history export");
      assert.equal(j029.description, "Acute pharyngitis unspecified", "description from the code set");
      assert.deepEqual(j029.sources.sort(), ["icd10-subset.csv", "practice-history.csv"]);

      assert.equal(codes[0].code, "J02.9", "most-used first");
      assert.equal(warnings.length, 0);
    }
  );
});

test("warns when a file parses to codes of no recognisable shape", async () => {
  await withTempDir({ "wrong-column.csv": "code,description\nAcute pharyngitis,J02.9\n" }, async (dir) => {
    const { warnings } = await loadCodeSet(dir);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /column mapping/);
  });
});

test("a missing directory is reported, not thrown", async () => {
  const { codes, warnings } = await loadCodeSet("/nonexistent/path/for/test");
  assert.deepEqual(codes, []);
  assert.match(warnings[0], /not found/);
});

test("validation matches regardless of formatting", async () => {
  await withTempDir({ "c.csv": "code,description\nJ02.9,Pharyngitis\n" }, async (dir) => {
    const { byKey } = await loadCodeSet(dir);
    assert.equal(isKnownCode(byKey, "j029"), true);
    assert.equal(isKnownCode(byKey, " J02.9 "), true);
    assert.equal(isKnownCode(byKey, "J02.8"), false);
  });
});
