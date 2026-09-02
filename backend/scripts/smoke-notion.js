// Manual verification for Chunk 1, build-order step 1: create a patient
// with two concurrent open cases against the real Notion databases, then
// read them back. Talks to Notion's live API, so it needs NOTION_API_KEY
// and the two data source IDs set -- see .env.example for where those
// come from.
//
// Run: npm run smoke:notion

import "dotenv/config";
import { createNotionRepositoryFromEnv } from "../src/repository/index.js";

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

let repository;
try {
  repository = createNotionRepositoryFromEnv();
} catch (err) {
  fail(err.message);
}

try {
  console.log("[ 1/4 ] Creating a synthetic patient...");
  const patient = await repository.createPatient({ name: "Molly Chen (synthetic)", dateOfBirth: "1990-04-12" });
  console.log(`  ok -- ${patient.patientId}: ${patient.name}`);

  console.log("\n[ 2/4 ] Opening two concurrent cases for that patient...");
  const ortho = await repository.createCase({ patientId: patient.patientId, title: "Broken left arm (synthetic)" });
  const pregnancy = await repository.createCase({ patientId: patient.patientId, title: "Pregnancy (synthetic)" });
  console.log(`  ok -- ${ortho.caseId}: ${ortho.title} (${ortho.status})`);
  console.log(`  ok -- ${pregnancy.caseId}: ${pregnancy.title} (${pregnancy.status})`);

  console.log("\n[ 3/4 ] Reading the patient and cases back...");
  const reloadedPatient = await repository.getPatient(patient.patientId);
  const cases = await repository.listCasesForPatient(patient.patientId);
  if (!reloadedPatient) fail(`getPatient('${patient.patientId}') returned null after create.`);
  if (cases.length !== 2) fail(`Expected 2 cases for ${patient.patientId}, found ${cases.length}.`);
  console.log(`  ok -- read back ${reloadedPatient.name} with ${cases.length} open cases`);

  console.log("\n[ 4/4 ] Closing one case and confirming the other stays open...");
  const closed = await repository.closeCase(ortho.caseId);
  const stillOpen = await repository.getCase(pregnancy.caseId);
  if (closed.status !== "closed") fail(`Expected ${ortho.caseId} to be closed, got '${closed.status}'.`);
  if (stillOpen.status !== "open") fail(`Expected ${pregnancy.caseId} to still be open, got '${stillOpen.status}'.`);
  console.log(`  ok -- ${closed.caseId} closed, ${stillOpen.caseId} still open`);

  console.log(
    `\nPASS. Check the Notion databases to confirm ${patient.patientId}, ${ortho.caseId}, and ${pregnancy.caseId} look right, then delete them -- this script leaves its data behind on purpose so you can inspect it.`
  );
} catch (err) {
  fail(err.message);
}
