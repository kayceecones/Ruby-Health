import test from "node:test";
import assert from "node:assert/strict";

import { NotionRepository, NotionRepositoryError } from "../src/repository/NotionRepository.js";

// A minimal in-memory stand-in for @notionhq/client, implementing just
// enough of dataSources.query / pages.create / pages.update to exercise
// NotionRepository's logic without a network call or a real integration
// token. One store per data source, one title property each.
function fakeNotionClient() {
  const stores = { patients: new Map(), cases: new Map(), encounters: new Map(), artifacts: new Map() };
  let nextPageId = 1;

  function storeFor(dataSourceId) {
    if (dataSourceId === "ds_patients") return stores.patients;
    if (dataSourceId === "ds_cases") return stores.cases;
    if (dataSourceId === "ds_encounters") return stores.encounters;
    if (dataSourceId === "ds_artifacts") return stores.artifacts;
    throw new Error(`fakeNotionClient: unknown data source '${dataSourceId}'`);
  }

  function matchesFilter(page, filter) {
    if (!filter) return true;
    if (filter.and) return filter.and.every((f) => matchesFilter(page, f));
    const value = page.properties[filter.property];
    if (filter.title) return (value?.title?.[0]?.text?.content || "") === filter.title.equals;
    if (filter.rich_text) return (value?.rich_text?.map((t) => t.text.content).join("") || "") === filter.rich_text.equals;
    if (filter.select) return (value?.select?.name || null) === filter.select.equals;
    throw new Error(`fakeNotionClient: unsupported filter ${JSON.stringify(filter)}`);
  }

  // The fake stores properties in "request" shape ({ title: [{ text: {...} }] })
  // and echoes them back reshaped into "response" shape (adding plain_text),
  // matching what the real API round-trips.
  function toResponseProperties(properties) {
    const out = {};
    for (const [key, value] of Object.entries(properties)) {
      if (value.title) {
        out[key] = { type: "title", title: value.title.map((t) => ({ ...t, plain_text: t.text.content })) };
      } else if (value.rich_text) {
        out[key] = { type: "rich_text", rich_text: value.rich_text.map((t) => ({ ...t, plain_text: t.text.content })) };
      } else if (value.date) {
        out[key] = { type: "date", date: value.date };
      } else if (value.select) {
        out[key] = { type: "select", select: value.select };
      } else if (typeof value.number === "number") {
        out[key] = { type: "number", number: value.number };
      } else {
        throw new Error(`fakeNotionClient: unsupported property shape ${JSON.stringify(value)}`);
      }
    }
    return out;
  }

  return {
    dataSources: {
      async query({ data_source_id, filter }) {
        const store = storeFor(data_source_id);
        const results = [...store.values()].filter((page) => matchesFilter(page, filter));
        return { results, has_more: false, next_cursor: null };
      },
    },
    pages: {
      async create({ parent, properties }) {
        const store = storeFor(parent.data_source_id);
        const page = {
          id: `page_${nextPageId++}`,
          created_time: "2026-09-02T00:00:00.000Z",
          properties: { ...toResponseProperties(properties), created_at: { type: "created_time", created_time: "2026-09-02T00:00:00.000Z" } },
        };
        store.set(page.id, page);
        return page;
      },
      async update({ page_id, properties }) {
        for (const store of Object.values(stores)) {
          if (store.has(page_id)) {
            const page = store.get(page_id);
            page.properties = { ...page.properties, ...toResponseProperties(properties) };
            return page;
          }
        }
        throw new Error(`fakeNotionClient: no page '${page_id}'`);
      },
    },
  };
}

function makeRepository() {
  return new NotionRepository({
    client: fakeNotionClient(),
    patientsDataSourceId: "ds_patients",
    casesDataSourceId: "ds_cases",
    encountersDataSourceId: "ds_encounters",
    artifactsDataSourceId: "ds_artifacts",
  });
}

async function makeCase(repo, { patientName = "Molly Chen", caseTitle = "Broken left arm" } = {}) {
  const patient = await repo.createPatient({ name: patientName, dateOfBirth: "1990-04-12" });
  const encounterCase = await repo.createCase({ patientId: patient.patientId, title: caseTitle });
  return { patient, case: encounterCase };
}

test("createPatient assigns sequential IDs starting at P001", async () => {
  const repo = makeRepository();
  const first = await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });
  const second = await repo.createPatient({ name: "Sam Rivera", dateOfBirth: "1985-11-02" });

  assert.equal(first.patientId, "P001");
  assert.equal(second.patientId, "P002");
  assert.equal(first.name, "Molly Chen");
  assert.equal(first.dateOfBirth, "1990-04-12");
});

test("createPatient rejects a missing name or date of birth", async () => {
  const repo = makeRepository();
  await assert.rejects(() => repo.createPatient({ dateOfBirth: "1990-04-12" }), NotionRepositoryError);
  await assert.rejects(() => repo.createPatient({ name: "Molly Chen" }), NotionRepositoryError);
});

test("getPatient finds an existing patient and returns null for an unknown one", async () => {
  const repo = makeRepository();
  const created = await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });

  assert.deepEqual(await repo.getPatient(created.patientId), created);
  assert.equal(await repo.getPatient("P999"), null);
});

test("listPatients returns every created patient", async () => {
  const repo = makeRepository();
  await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });
  await repo.createPatient({ name: "Sam Rivera", dateOfBirth: "1985-11-02" });

  const patients = await repo.listPatients();
  assert.equal(patients.length, 2);
  assert.deepEqual(
    patients.map((p) => p.name).sort(),
    ["Molly Chen", "Sam Rivera"],
  );
});

test("a patient can have two concurrent open cases", async () => {
  const repo = makeRepository();
  const patient = await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });

  const ortho = await repo.createCase({ patientId: patient.patientId, title: "Broken left arm" });
  const pregnancy = await repo.createCase({ patientId: patient.patientId, title: "Pregnancy" });

  assert.equal(ortho.caseId, "C001");
  assert.equal(pregnancy.caseId, "C002");
  assert.equal(ortho.status, "open");
  assert.equal(pregnancy.status, "open");
  assert.equal(ortho.patientId, patient.patientId);

  const cases = await repo.listCasesForPatient(patient.patientId);
  assert.equal(cases.length, 2);
  assert.deepEqual(
    cases.map((c) => c.title).sort(),
    ["Broken left arm", "Pregnancy"],
  );
});

test("createCase rejects a patientId that doesn't exist", async () => {
  const repo = makeRepository();
  await assert.rejects(
    () => repo.createCase({ patientId: "P999", title: "Broken left arm" }),
    NotionRepositoryError,
  );
});

test("closeCase sets status to closed and stamps closedAt", async () => {
  const repo = makeRepository();
  const patient = await repo.createPatient({ name: "Molly Chen", dateOfBirth: "1990-04-12" });
  const created = await repo.createCase({ patientId: patient.patientId, title: "Broken left arm" });

  assert.equal(created.closedAt, null);

  const closed = await repo.closeCase(created.caseId);
  assert.equal(closed.status, "closed");
  assert.ok(closed.closedAt);

  const reloaded = await repo.getCase(created.caseId);
  assert.equal(reloaded.status, "closed");
});

test("closeCase rejects a caseId that doesn't exist", async () => {
  const repo = makeRepository();
  await assert.rejects(() => repo.closeCase("C999"), NotionRepositoryError);
});

test("createEncounter derives patientId from the case, defaults to draft", async () => {
  const repo = makeRepository();
  const { patient, case: c } = await makeCase(repo);

  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  assert.equal(encounter.encounterId, "E001");
  assert.equal(encounter.caseId, c.caseId);
  assert.equal(encounter.patientId, patient.patientId);
  assert.equal(encounter.status, "draft");
});

test("createEncounter rejects a caseId that doesn't exist", async () => {
  const repo = makeRepository();
  await assert.rejects(() => repo.createEncounter({ caseId: "C999", occurredAt: "2026-09-01" }), NotionRepositoryError);
});

test("listEncountersForCase returns them in chronological order", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-03" });
  await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });
  await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-02" });

  const encounters = await repo.listEncountersForCase(c.caseId);
  assert.deepEqual(
    encounters.map((e) => e.occurredAt),
    ["2026-09-01", "2026-09-02", "2026-09-03"],
  );
});

test("updateEncounterStatus changes status", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  const updated = await repo.updateEncounterStatus(encounter.encounterId, "reviewed");
  assert.equal(updated.status, "reviewed");
});

test("running the pipeline against a synthetic transcript persists four versioned artifacts under one encounter", async () => {
  // This is build-order step 2's own verification: create an encounter,
  // persist transcript -> facts -> codes -> claim as it would come out of
  // the real pipeline, and confirm all four land as separate artifact
  // versions under that one encounter.
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  const stageOutputs = {
    transcript: { cleaned: "Patient reports sore throat for three days." },
    facts: { chiefComplaint: "Sore throat", symptoms: ["sore throat"] },
    codes: [{ code: "J02.9", codeType: "ICD-10", description: "Acute pharyngitis" }],
    claim: { serviceLines: [{ code: "87880", diagnosisPointers: "A" }] },
  };

  for (const [stage, content] of Object.entries(stageOutputs)) {
    await repo.createArtifact({ encounterId: encounter.encounterId, stage, content, createdBy: "system" });
  }

  const history = await repo.getArtifactHistory(encounter.encounterId);
  assert.equal(history.length, 4);
  assert.deepEqual(
    history.map((a) => a.stage),
    ["transcript", "facts", "codes", "claim"],
  );
  for (const artifact of history) {
    assert.equal(artifact.version, 1);
    assert.equal(artifact.encounterId, encounter.encounterId);
    assert.deepEqual(artifact.content, stageOutputs[artifact.stage]);
  }
});

test("createArtifact increments version per (encounter, stage) instead of overwriting", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  await repo.createArtifact({
    encounterId: encounter.encounterId,
    stage: "facts",
    content: { chiefComplaint: "Sore throat" },
    createdBy: "system",
  });
  const editedVersion = await repo.createArtifact({
    encounterId: encounter.encounterId,
    stage: "facts",
    content: { chiefComplaint: "Sore throat, worsening" },
    createdBy: "provider_edit",
  });

  assert.equal(editedVersion.version, 2);

  const latest = await repo.getLatestArtifact(encounter.encounterId, "facts");
  assert.equal(latest.version, 2);
  assert.deepEqual(latest.content, { chiefComplaint: "Sore throat, worsening" });

  const history = await repo.getArtifactHistory(encounter.encounterId);
  assert.equal(history.length, 2, "editing a stage adds a version, it does not overwrite the old one");
});

test("createArtifact content survives the round trip past Notion's 2000-char rich_text limit", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  const bigContent = { note: "x".repeat(5000) };
  const artifact = await repo.createArtifact({
    encounterId: encounter.encounterId,
    stage: "transcript",
    content: bigContent,
    createdBy: "system",
  });

  assert.deepEqual(artifact.content, bigContent);
  const reloaded = await repo.getLatestArtifact(encounter.encounterId, "transcript");
  assert.deepEqual(reloaded.content, bigContent);
});

test("createArtifact rejects an encounterId that doesn't exist", async () => {
  const repo = makeRepository();
  await assert.rejects(
    () => repo.createArtifact({ encounterId: "E999", stage: "facts", content: {}, createdBy: "system" }),
    NotionRepositoryError,
  );
});

test("createArtifact rejects an unknown stage or createdBy", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  await assert.rejects(
    () => repo.createArtifact({ encounterId: encounter.encounterId, stage: "vitals", content: {}, createdBy: "system" }),
    NotionRepositoryError,
  );
  await assert.rejects(
    () => repo.createArtifact({ encounterId: encounter.encounterId, stage: "facts", content: {}, createdBy: "provider" }),
    NotionRepositoryError,
  );
});

test("getLatestArtifact returns null when a stage has no artifacts yet", async () => {
  const repo = makeRepository();
  const { case: c } = await makeCase(repo);
  const encounter = await repo.createEncounter({ caseId: c.caseId, occurredAt: "2026-09-01" });

  assert.equal(await repo.getLatestArtifact(encounter.encounterId, "claim"), null);
});
