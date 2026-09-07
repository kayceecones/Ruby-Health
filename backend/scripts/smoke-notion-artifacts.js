// Manual verification for Chunk 1, build-order step 2: "run the existing
// pipeline against a synthetic transcript, confirm four versioned artifacts
// persist under one encounter." This drives the repository the same way
// the real pipeline eventually will (see backend/src/pipeline/*.js for the
// actual stage outputs it produces), without calling Claude or Stedi --
// synthetic stage content in, real Notion writes out. Talks to Notion's
// live API, so it needs NOTION_API_KEY and all four data source IDs set.
//
// Run: npm run smoke:notion-artifacts

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

const STAGE_OUTPUTS = {
  transcript: { cleaned: "Patient reports sore throat for three days. (synthetic)" },
  facts: { chiefComplaint: "Sore throat", symptoms: ["sore throat"], medicalNecessityLanguage: ["persisted for three days"] },
  codes: [{ code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis" }],
  claim: { serviceLines: [{ code: "87880", diagnosisPointers: "A" }] },
};

try {
  console.log("[ 1/3 ] Creating a synthetic patient, case, and encounter...");
  const patient = await repository.createPatient({ name: "Sam Rivera (synthetic)", dateOfBirth: "1985-11-02" });
  const encounterCase = await repository.createCase({ patientId: patient.patientId, title: "Sore throat visit (synthetic)" });
  const encounter = await repository.createEncounter({ caseId: encounterCase.caseId, occurredAt: new Date().toISOString().slice(0, 10) });
  console.log(`  ok -- ${patient.patientId} / ${encounterCase.caseId} / ${encounter.encounterId} (status: ${encounter.status})`);

  console.log("\n[ 2/3 ] Persisting all four pipeline stages as artifacts under that encounter...");
  for (const [stage, content] of Object.entries(STAGE_OUTPUTS)) {
    const artifact = await repository.createArtifact({ encounterId: encounter.encounterId, stage, content, createdBy: "system" });
    console.log(`  ok -- ${artifact.artifactId}: ${stage} v${artifact.version}`);
  }

  console.log("\n[ 3/3 ] Reading the artifact history back and confirming all four are there...");
  const history = await repository.getArtifactHistory(encounter.encounterId);
  if (history.length !== 4) fail(`Expected 4 artifacts for ${encounter.encounterId}, found ${history.length}.`);
  const stagesFound = history.map((a) => a.stage).sort();
  if (JSON.stringify(stagesFound) !== JSON.stringify(["claim", "codes", "facts", "transcript"])) {
    fail(`Expected one artifact per stage, got: ${stagesFound.join(", ")}`);
  }
  console.log(`  ok -- ${history.length} artifacts: ${history.map((a) => a.stage).join(", ")}`);

  console.log(
    `\nPASS. Check the Notion databases to confirm ${patient.patientId} / ${encounterCase.caseId} / ${encounter.encounterId} and its 4 artifacts look right, then delete them -- this script leaves its data behind on purpose so you can inspect it.`
  );
} catch (err) {
  fail(err.message);
}
