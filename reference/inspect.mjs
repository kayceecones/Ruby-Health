// Report what was read from reference/codes/ and how it was interpreted.
//
//   node reference/inspect.mjs
//
// Run this straight after adding a file. A code list that silently parsed the
// wrong column is worse than no code list: validation would reject correct
// codes and retrieval would offer nonsense, both with total confidence.

import { loadCodeSet, CODES_DIR } from "./loadCodes.mjs";

const { codes, sources, warnings } = await loadCodeSet();

if (sources.length === 0) {
  console.log(`\nNo code files found in ${CODES_DIR}`);
  console.log("Add a .csv, .tsv, .txt or .json file there — see reference/README.md.\n");
  process.exit(0);
}

console.log("\nFiles read\n" + "-".repeat(72));
for (const s of sources) {
  const flag = s.unrecognisedShape > 0 ? `  ⚠ ${s.unrecognisedShape} unrecognised` : "";
  console.log(`  ${s.file.padEnd(38)} ${String(s.parsed).padStart(6)} rows, ${String(s.added).padStart(6)} new${flag}`);
}

const byType = codes.reduce((acc, c) => ((acc[c.type] = (acc[c.type] || 0) + 1), acc), {});
console.log("\nTotals\n" + "-".repeat(72));
console.log(`  ${codes.length} distinct codes`);
for (const [type, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${type.padEnd(10)} ${n}`);
}

const described = codes.filter((c) => c.description).length;
const withFreq = codes.filter((c) => c.frequency != null).length;
console.log(`  ${described} have a description  (${codes.length - described} without — retrieval works far better with them)`);
console.log(`  ${withFreq} have a usage count`);

// A sample is the fastest way to catch a column mapping that parsed cleanly
// but read the wrong field.
console.log("\nSample — check these look like real codes and descriptions\n" + "-".repeat(72));
for (const c of codes.slice(0, 12)) {
  const freq = c.frequency != null ? String(c.frequency).padStart(7) : "      -";
  console.log(`  ${c.code.padEnd(10)} ${c.type.padEnd(8)} ${freq}  ${c.description.slice(0, 44) || "(no description)"}`);
}

if (warnings.length) {
  console.log("\nWarnings\n" + "-".repeat(72));
  for (const w of warnings) console.log(`  ⚠ ${w}`);
}

console.log("");
