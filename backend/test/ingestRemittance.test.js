import test from "node:test";
import assert from "node:assert/strict";

import { ingestRemittance, RemittanceIngestError, CLAIM_STATUS_FROM_ADJUDICATION } from "../src/pipeline/ingestRemittance.js";
import { loadAdjustmentCodes } from "../../reference/loadAdjustmentCodes.mjs";

const adjustmentCodes = await loadAdjustmentCodes();

// Just enough repository to watch what ingestion does to a claim. Narrower
// than the fake Notion client in NotionRepository.test.js on purpose -- what
// is under test here is the orchestration, not the persistence.
function stubRepository({ claim = { claimId: "CL001", status: "submitted", payerClaimControlNumber: null } } = {}) {
  const calls = { feedback: [], statusUpdates: [], controlNumbers: [] };
  return {
    calls,
    async getClaim(claimId) {
      return claimId === claim.claimId ? { ...claim } : null;
    },
    async createPayerFeedback(input) {
      calls.feedback.push(input);
      return { feedbackId: `PF00${calls.feedback.length}`, ...input };
    },
    async setPayerClaimControlNumber(claimId, controlNumber) {
      calls.controlNumbers.push({ claimId, controlNumber });
      return { ...claim, payerClaimControlNumber: controlNumber };
    },
    async updateClaimStatus(claimId, status) {
      calls.statusUpdates.push({ claimId, status });
      return { ...claim, status };
    },
  };
}

// Synthetic. reference/README.md: a real 835 carries PHI and never lands here.
const DENIED_REMITTANCE = {
  payerClaimControlNumber: "2026250012345",
  claimStatusCode: 4,
  productionDate: "2026-09-05",
  payerName: "Sample Payer Insurance",
  totalClaimChargeAmount: "150.00",
  claimPaymentAmount: "0.00",
  serviceLines: [
    {
      procedureCode: "99213",
      lineItemChargeAmount: "150.00",
      lineItemProviderPaymentAmount: "0.00",
      adjustments: [{ adjustmentGroupCode: "CO", adjustmentReasonCode: "50", adjustmentAmount: "150.00" }],
    },
  ],
};

test("ingesting a denial files the feedback and moves the claim to denied", async () => {
  const repository = stubRepository();

  const result = await ingestRemittance({
    repository,
    adjustmentCodes,
    claimId: "CL001",
    remittance: DENIED_REMITTANCE,
    dateOfService: "2026-08-20",
    today: "2026-09-08",
  });

  assert.equal(result.claimStatus, "denied");
  assert.equal(result.analysis.recommendedRoute, "appeal");
  assert.equal(result.analysis.money.atRisk, 150);

  const [filed] = repository.calls.feedback;
  assert.equal(filed.claimId, "CL001");
  assert.equal(filed.feedbackType, "remittance");
  assert.equal(filed.claimStatus, "denied");
  assert.equal(filed.recommendedRoute, "appeal");
  assert.equal(filed.amountAtRisk, 150);
  // The date comes off the document, not off the clock.
  assert.equal(filed.receivedAt, "2026-09-05");
  // Both the payer's reading and ours are kept.
  assert.ok(filed.content.adjudication);
  assert.ok(filed.content.analysis);

  assert.deepEqual(repository.calls.statusUpdates, [{ claimId: "CL001", status: "denied" }]);
});

test("the payer's control number is written back to the claim", async () => {
  // Without this the claim can never be corrected -- the payer reads a
  // resubmission carrying no control number as a duplicate.
  const repository = stubRepository();
  await ingestRemittance({ repository, adjustmentCodes, claimId: "CL001", remittance: DENIED_REMITTANCE });

  assert.deepEqual(repository.calls.controlNumbers, [{ claimId: "CL001", controlNumber: "2026250012345" }]);
});

test("a remittance with no control number does not write an empty one", async () => {
  const repository = stubRepository();
  await ingestRemittance({
    repository,
    adjustmentCodes,
    claimId: "CL001",
    remittance: { ...DENIED_REMITTANCE, payerClaimControlNumber: undefined },
  });

  assert.equal(repository.calls.controlNumbers.length, 0);
  assert.equal(repository.calls.statusUpdates.length, 1);
});

test("a claim paid to the deductible is accepted, not denied", async () => {
  const repository = stubRepository();
  const result = await ingestRemittance({
    repository,
    adjustmentCodes,
    claimId: "CL001",
    remittance: {
      payerClaimControlNumber: "2026250099999",
      totalClaimChargeAmount: "120.00",
      claimPaymentAmount: "0.00",
      serviceLines: [
        {
          procedureCode: "99213",
          lineItemChargeAmount: "120.00",
          lineItemProviderPaymentAmount: "0.00",
          adjustments: [{ adjustmentGroupCode: "PR", adjustmentReasonCode: "1", adjustmentAmount: "120.00" }],
        },
      ],
    },
  });

  // The provider was paid nothing, but this is a bill to send, not a fight.
  assert.equal(result.claimStatus, "accepted");
  assert.equal(result.analysis.recommendedRoute, "bill_patient");
  assert.equal(result.analysis.money.atRisk, 0);
});

test("every adjudication status maps to one Ruby claim status", async () => {
  // A status with no mapping would silently fall through to "pending" and
  // quietly strand the claim, so the table has to stay exhaustive.
  for (const status of [
    "paid",
    "partially_paid",
    "patient_responsibility",
    "denied",
    "not_our_claim",
    "reversed",
    "forwarded",
    "predetermination",
    "unknown",
  ]) {
    assert.ok(
      ["draft", "submitted", "accepted", "denied", "pending"].includes(CLAIM_STATUS_FROM_ADJUDICATION[status]),
      `${status} has no valid claim status mapping`
    );
  }
});

test("a multi-claim document files the first and reports the rest", async () => {
  const repository = stubRepository();
  const result = await ingestRemittance({
    repository,
    adjustmentCodes,
    claimId: "CL001",
    remittance: { claims: [DENIED_REMITTANCE, DENIED_REMITTANCE, DENIED_REMITTANCE] },
  });

  assert.equal(result.otherClaimsInDocument, 2);
  assert.equal(repository.calls.feedback.length, 1);
});

test("the raw document is kept alongside our reading of it", async () => {
  const stored = [];
  const blobStore = {
    async putBlob(key, content) {
      stored.push({ key, content });
      return `blob://${key}`;
    },
  };
  const repository = stubRepository();

  await ingestRemittance({ repository, blobStore, adjustmentCodes, claimId: "CL001", remittance: DENIED_REMITTANCE });

  assert.equal(stored.length, 1);
  assert.match(stored[0].key, /^remittance\/CL001-/);
  assert.equal(repository.calls.feedback[0].storageRef, stored[0].key ? `blob://${stored[0].key}` : null);
  // The stored bytes are the payer's document, not our parse of it.
  assert.equal(JSON.parse(stored[0].content.toString()).payerClaimControlNumber, "2026250012345");
});

test("a blob-storage failure does not lose the reading we already have", async () => {
  const blobStore = {
    async putBlob() {
      throw new Error("disk full");
    },
  };
  const repository = stubRepository();

  const result = await ingestRemittance({ repository, blobStore, adjustmentCodes, claimId: "CL001", remittance: DENIED_REMITTANCE });

  assert.equal(result.claimStatus, "denied");
  assert.equal(repository.calls.feedback[0].storageRef, null);
});

test("ingesting against a claim that doesn't exist is a 404, not a 500", async () => {
  const repository = stubRepository();
  await assert.rejects(
    () => ingestRemittance({ repository, adjustmentCodes, claimId: "CL999", remittance: DENIED_REMITTANCE }),
    (err) => err instanceof RemittanceIngestError && err.status === 404
  );
});

test("a missing remittance payload is rejected before anything is written", async () => {
  const repository = stubRepository();
  await assert.rejects(
    () => ingestRemittance({ repository, adjustmentCodes, claimId: "CL001", remittance: null }),
    RemittanceIngestError
  );
  assert.equal(repository.calls.feedback.length, 0);
  assert.equal(repository.calls.statusUpdates.length, 0);
});
