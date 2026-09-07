// Manual verification for Chunk 1, build-order step 4: "write and read a
// file through the interface. No UI." Exercises both halves -- the
// BlobStore for the actual bytes, and the Notion-backed Document metadata
// pointing at it. Talks to Notion's live API for the metadata half, so it
// needs NOTION_API_KEY and all six data source IDs set; the blob half is
// local disk and needs nothing.
//
// Run: npm run smoke:notion-documents

import "dotenv/config";
import { createNotionRepositoryFromEnv, createBlobStoreFromEnv } from "../src/repository/index.js";

function fail(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

let repository, blobStore;
try {
  repository = createNotionRepositoryFromEnv();
  blobStore = createBlobStoreFromEnv();
} catch (err) {
  fail(err.message);
}

try {
  console.log("[ 1/3 ] Writing a synthetic file through the BlobStore...");
  const fileContent = Buffer.from("Synthetic prior-authorization letter, not a real document.");
  const storageRef = await blobStore.putBlob(`smoke-test/${Date.now()}.txt`, fileContent);
  console.log(`  ok -- wrote ${fileContent.length} bytes to storageRef '${storageRef}'`);

  console.log("\n[ 2/3 ] Creating a synthetic patient and a Document record pointing at it...");
  const patient = await repository.createPatient({ name: "Ana Petrov (synthetic)", dateOfBirth: "1992-02-14" });
  const document = await repository.createDocument({
    patientId: patient.patientId,
    source: "upload",
    documentDate: new Date().toISOString().slice(0, 10),
    storageRef,
  });
  console.log(`  ok -- ${document.documentId} (extractionStatus: ${document.extractionStatus}, storageRef: ${document.storageRef})`);

  console.log("\n[ 3/3 ] Reading both back and confirming the bytes round-trip...");
  const reloadedDocument = await repository.getDocument(document.documentId);
  const reloadedContent = await blobStore.getBlob(reloadedDocument.storageRef);
  if (!reloadedContent.equals(fileContent)) fail("Blob content did not round-trip byte-for-byte.");
  console.log(`  ok -- read back ${reloadedContent.length} bytes, matches what was written`);

  console.log(
    `\nPASS. Check the Documents database to confirm ${patient.patientId} / ${document.documentId} look right, and backend/data/blobs/smoke-test/ for the file -- both are left behind on purpose so you can inspect them.`
  );
} catch (err) {
  fail(err.message);
}
