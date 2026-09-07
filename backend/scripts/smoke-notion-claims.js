// Manual verification for Chunk 1, build-order step 3: "create an original
// claim, then a corrected claim pointing at it." Talks to Notion's live
// API, so it needs NOTION_API_KEY and all five data source IDs set.
//
// Run: npm run smoke:notion-claims

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
  console.log("[ 1/4 ] Creating a synthetic patient, case, encounter, and claim artifact...");
  const patient = await repository.createPatient({ name: "Jordan Lee (synthetic)", dateOfBirth: "1978-06-30" });
  const encounterCase = await repository.createCase({ patientId: patient.patientId, title: "Sprained ankle (synthetic)" });
  const encounter = await repository.createEncounter({ caseId: encounterCase.caseId, occurredAt: new Date().toISOString().slice(0, 10) });
  const artifact = await repository.createArtifact({
    encounterId: encounter.encounterId,
    stage: "claim",
    content: { serviceLines: [{ code: "99213", diagnosisPointers: "A" }] },
    createdBy: "system",
  });
  console.log(`  ok -- ${patient.patientId} / ${encounterCase.caseId} / ${encounter.encounterId} / ${artifact.artifactId}`);

  console.log("\n[ 2/4 ] Creating the original claim, then denying it...");
  const original = await repository.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "original",
    payerName: "Sample Payer Insurance",
    memberId: "M999000",
  });
  await repository.updateClaimStatus(original.claimId, "denied");
  console.log(`  ok -- ${original.claimId} (original, now denied)`);

  console.log("\n[ 3/4 ] Creating a corrected claim pointing at the original...");
  const corrected = await repository.createClaim({
    encounterId: encounter.encounterId,
    artifactId: artifact.artifactId,
    claimType: "corrected",
    parentClaimId: original.claimId,
    payerName: "Sample Payer Insurance",
    memberId: "M999000",
  });
  console.log(`  ok -- ${corrected.claimId} (corrected, parent: ${corrected.parentClaimId})`);

  console.log("\n[ 4/4 ] Reading the claim chain back from either end...");
  const chain = await repository.getClaimChain(original.claimId);
  if (chain.length !== 2) fail(`Expected a 2-claim chain, found ${chain.length}.`);
  if (chain[0].claimId !== original.claimId || chain[1].claimId !== corrected.claimId) {
    fail(`Expected [${original.claimId}, ${corrected.claimId}] oldest first, got [${chain.map((c) => c.claimId).join(", ")}]`);
  }
  console.log(`  ok -- chain: ${chain.map((c) => `${c.claimId} (${c.claimType}, ${c.status})`).join(" -> ")}`);

  console.log(
    `\nPASS. Check the Notion databases to confirm ${patient.patientId} through ${corrected.claimId} look right, then delete them -- this script leaves its data behind on purpose so you can inspect it.`
  );
} catch (err) {
  fail(err.message);
}
