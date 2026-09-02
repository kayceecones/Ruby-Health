// Notion-backed Repository. Demo only -- synthetic data only. See
// Repository.js for the interface contract and reference/README-adjacent
// constraints: this file must never be handed real patient data, and no
// other module should import @notionhq/client or know a Notion page ID
// exists. That boundary is what lets a PostgresRepository replace this one
// later without touching a call site.
//
// IDs are sequential and human-readable (P001, C001, ...), per the demo
// convention -- production must mint UUIDs instead, since sequential IDs
// are enumerable. Foreign keys (a Case's patient_id) are stored as plain
// text, not Notion relations, so the adapter's behavior stays close to
// what the Postgres implementation will do.

import { Repository } from "./Repository.js";

export class NotionRepositoryError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotionRepositoryError";
  }
}

const STAGES = ["transcript", "facts", "codes", "claim"];
const CREATED_BY_VALUES = ["system", "provider_edit"];

function titleText(page, property) {
  return page.properties[property]?.title?.[0]?.plain_text || "";
}

function richText(page, property) {
  return page.properties[property]?.rich_text?.[0]?.plain_text || "";
}

// Notion caps each rich_text item at 2000 characters. Artifact content is
// arbitrary pipeline-stage JSON and can easily exceed that, so it's written
// and read as a concatenation of chunks rather than a single item.
function richTextAll(page, property) {
  return (page.properties[property]?.rich_text || []).map((item) => item.plain_text).join("");
}

const RICH_TEXT_CHUNK_SIZE = 2000;

function chunkedRichText(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += RICH_TEXT_CHUNK_SIZE) {
    chunks.push({ text: { content: text.slice(i, i + RICH_TEXT_CHUNK_SIZE) } });
  }
  // Notion rejects an empty rich_text array -- an empty string still needs
  // one (empty) chunk to round-trip as "" rather than being omitted.
  return chunks.length > 0 ? chunks : [{ text: { content: "" } }];
}

function dateValue(page, property) {
  return page.properties[property]?.date?.start || null;
}

function selectValue(page, property) {
  return page.properties[property]?.select?.name || null;
}

function numberValue(page, property) {
  const value = page.properties[property]?.number;
  return typeof value === "number" ? value : null;
}

function parsePatient(page) {
  return {
    patientId: titleText(page, "patient_id"),
    name: richText(page, "name"),
    dateOfBirth: dateValue(page, "date_of_birth"),
    createdAt: page.properties.created_at?.created_time || page.created_time || null,
  };
}

function parseCase(page) {
  return {
    caseId: titleText(page, "case_id"),
    patientId: richText(page, "patient_id"),
    title: richText(page, "title"),
    status: selectValue(page, "status"),
    openedAt: dateValue(page, "opened_at"),
    closedAt: dateValue(page, "closed_at"),
  };
}

function parseEncounter(page) {
  return {
    encounterId: titleText(page, "encounter_id"),
    caseId: richText(page, "case_id"),
    patientId: richText(page, "patient_id"),
    occurredAt: dateValue(page, "occurred_at"),
    status: selectValue(page, "status"),
    createdAt: page.properties.created_at?.created_time || page.created_time || null,
  };
}

function parseArtifact(page) {
  const raw = richTextAll(page, "content");
  let content = null;
  try {
    content = raw ? JSON.parse(raw) : null;
  } catch {
    // Should never happen -- createArtifact always writes JSON.stringify
    // output. Surfacing the raw text beats throwing on read.
    content = raw;
  }
  return {
    artifactId: titleText(page, "artifact_id"),
    encounterId: richText(page, "encounter_id"),
    stage: selectValue(page, "stage"),
    version: numberValue(page, "version"),
    content,
    createdBy: selectValue(page, "created_by"),
    createdAt: page.properties.created_at?.created_time || page.created_time || null,
  };
}

export class NotionRepository extends Repository {
  /**
   * @param {{ client: import("@notionhq/client").Client,
   *   patientsDataSourceId: string, casesDataSourceId: string,
   *   encountersDataSourceId?: string, artifactsDataSourceId?: string }} config
   *   The encounter/artifact IDs are optional for now so existing callers built
   *   against just Patient/Case don't need to change -- methods that need them
   *   throw a clear config error instead of a confusing undefined-ID query.
   */
  constructor({ client, patientsDataSourceId, casesDataSourceId, encountersDataSourceId, artifactsDataSourceId }) {
    super();
    if (!client) throw new NotionRepositoryError("NotionRepository requires a Notion client.");
    if (!patientsDataSourceId) throw new NotionRepositoryError("NotionRepository requires patientsDataSourceId.");
    if (!casesDataSourceId) throw new NotionRepositoryError("NotionRepository requires casesDataSourceId.");
    this.client = client;
    this.patientsDataSourceId = patientsDataSourceId;
    this.casesDataSourceId = casesDataSourceId;
    this.encountersDataSourceId = encountersDataSourceId;
    this.artifactsDataSourceId = artifactsDataSourceId;
  }

  _requireEncountersDataSource() {
    if (!this.encountersDataSourceId) {
      throw new NotionRepositoryError("NotionRepository was not configured with encountersDataSourceId.");
    }
  }

  _requireArtifactsDataSource() {
    if (!this.artifactsDataSourceId) {
      throw new NotionRepositoryError("NotionRepository was not configured with artifactsDataSourceId.");
    }
  }

  async createPatient({ name, dateOfBirth }) {
    if (!name) throw new NotionRepositoryError("createPatient requires a name.");
    if (!dateOfBirth) throw new NotionRepositoryError("createPatient requires a dateOfBirth.");

    const patientId = await this._nextSequentialId(this.patientsDataSourceId, "patient_id", "P");
    const page = await this.client.pages.create({
      parent: { data_source_id: this.patientsDataSourceId },
      properties: {
        patient_id: { title: [{ text: { content: patientId } }] },
        name: { rich_text: [{ text: { content: name } }] },
        date_of_birth: { date: { start: dateOfBirth } },
      },
    });
    return parsePatient(page);
  }

  async getPatient(patientId) {
    const page = await this._findByTitle(this.patientsDataSourceId, "patient_id", patientId);
    return page ? parsePatient(page) : null;
  }

  async listPatients() {
    const pages = await this._queryAll(this.patientsDataSourceId);
    return pages.map(parsePatient);
  }

  async createCase({ patientId, title }) {
    if (!patientId) throw new NotionRepositoryError("createCase requires a patientId.");
    if (!title) throw new NotionRepositoryError("createCase requires a title.");

    const patient = await this.getPatient(patientId);
    if (!patient) throw new NotionRepositoryError(`No patient found with patient_id '${patientId}'.`);

    const caseId = await this._nextSequentialId(this.casesDataSourceId, "case_id", "C");
    const openedAt = new Date().toISOString().slice(0, 10);
    const page = await this.client.pages.create({
      parent: { data_source_id: this.casesDataSourceId },
      properties: {
        case_id: { title: [{ text: { content: caseId } }] },
        patient_id: { rich_text: [{ text: { content: patientId } }] },
        title: { rich_text: [{ text: { content: title } }] },
        status: { select: { name: "open" } },
        opened_at: { date: { start: openedAt } },
      },
    });
    return parseCase(page);
  }

  async getCase(caseId) {
    const page = await this._findByTitle(this.casesDataSourceId, "case_id", caseId);
    return page ? parseCase(page) : null;
  }

  async listCasesForPatient(patientId) {
    const pages = await this._queryAll(this.casesDataSourceId, {
      property: "patient_id",
      rich_text: { equals: patientId },
    });
    return pages.map(parseCase);
  }

  async closeCase(caseId) {
    const page = await this._findByTitle(this.casesDataSourceId, "case_id", caseId);
    if (!page) throw new NotionRepositoryError(`No case found with case_id '${caseId}'.`);

    const closedAt = new Date().toISOString().slice(0, 10);
    const updated = await this.client.pages.update({
      page_id: page.id,
      properties: {
        status: { select: { name: "closed" } },
        closed_at: { date: { start: closedAt } },
      },
    });
    return parseCase(updated);
  }

  async createEncounter({ caseId, occurredAt }) {
    this._requireEncountersDataSource();
    if (!caseId) throw new NotionRepositoryError("createEncounter requires a caseId.");
    if (!occurredAt) throw new NotionRepositoryError("createEncounter requires an occurredAt.");

    const encounterCase = await this.getCase(caseId);
    if (!encounterCase) throw new NotionRepositoryError(`No case found with case_id '${caseId}'.`);

    const encounterId = await this._nextSequentialId(this.encountersDataSourceId, "encounter_id", "E");
    const page = await this.client.pages.create({
      parent: { data_source_id: this.encountersDataSourceId },
      properties: {
        encounter_id: { title: [{ text: { content: encounterId } }] },
        case_id: { rich_text: [{ text: { content: caseId } }] },
        patient_id: { rich_text: [{ text: { content: encounterCase.patientId } }] },
        occurred_at: { date: { start: occurredAt } },
        status: { select: { name: "draft" } },
      },
    });
    return parseEncounter(page);
  }

  async getEncounter(encounterId) {
    this._requireEncountersDataSource();
    const page = await this._findByTitle(this.encountersDataSourceId, "encounter_id", encounterId);
    return page ? parseEncounter(page) : null;
  }

  async listEncountersForCase(caseId) {
    this._requireEncountersDataSource();
    const pages = await this._queryAll(this.encountersDataSourceId, {
      property: "case_id",
      rich_text: { equals: caseId },
    });
    return pages.map(parseEncounter).sort((a, b) => (a.occurredAt || "").localeCompare(b.occurredAt || ""));
  }

  async updateEncounterStatus(encounterId, status) {
    this._requireEncountersDataSource();
    const page = await this._findByTitle(this.encountersDataSourceId, "encounter_id", encounterId);
    if (!page) throw new NotionRepositoryError(`No encounter found with encounter_id '${encounterId}'.`);

    const updated = await this.client.pages.update({
      page_id: page.id,
      properties: { status: { select: { name: status } } },
    });
    return parseEncounter(updated);
  }

  async createArtifact({ encounterId, stage, content, createdBy }) {
    this._requireArtifactsDataSource();
    if (!encounterId) throw new NotionRepositoryError("createArtifact requires an encounterId.");
    if (!STAGES.includes(stage)) throw new NotionRepositoryError(`createArtifact stage must be one of: ${STAGES.join(", ")}.`);
    if (!CREATED_BY_VALUES.includes(createdBy)) {
      throw new NotionRepositoryError(`createArtifact createdBy must be one of: ${CREATED_BY_VALUES.join(", ")}.`);
    }

    const encounter = await this.getEncounter(encounterId);
    if (!encounter) throw new NotionRepositoryError(`No encounter found with encounter_id '${encounterId}'.`);

    const priorVersions = await this._queryAll(this.artifactsDataSourceId, {
      and: [
        { property: "encounter_id", rich_text: { equals: encounterId } },
        { property: "stage", select: { equals: stage } },
      ],
    });
    const version = priorVersions.reduce((max, page) => Math.max(max, numberValue(page, "version") || 0), 0) + 1;

    const artifactId = await this._nextSequentialId(this.artifactsDataSourceId, "artifact_id", "A");
    const page = await this.client.pages.create({
      parent: { data_source_id: this.artifactsDataSourceId },
      properties: {
        artifact_id: { title: [{ text: { content: artifactId } }] },
        encounter_id: { rich_text: [{ text: { content: encounterId } }] },
        stage: { select: { name: stage } },
        version: { number: version },
        content: { rich_text: chunkedRichText(JSON.stringify(content)) },
        created_by: { select: { name: createdBy } },
      },
    });
    return parseArtifact(page);
  }

  async getArtifactHistory(encounterId) {
    this._requireArtifactsDataSource();
    const pages = await this._queryAll(this.artifactsDataSourceId, {
      property: "encounter_id",
      rich_text: { equals: encounterId },
    });
    return pages
      .map(parseArtifact)
      .sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage) || b.version - a.version);
  }

  async getLatestArtifact(encounterId, stage) {
    this._requireArtifactsDataSource();
    const pages = await this._queryAll(this.artifactsDataSourceId, {
      and: [
        { property: "encounter_id", rich_text: { equals: encounterId } },
        { property: "stage", select: { equals: stage } },
      ],
    });
    if (pages.length === 0) return null;
    const artifacts = pages.map(parseArtifact);
    return artifacts.reduce((latest, artifact) => (artifact.version > latest.version ? artifact : latest));
  }

  async _findByTitle(dataSourceId, titleProperty, value) {
    const response = await this.client.dataSources.query({
      data_source_id: dataSourceId,
      filter: { property: titleProperty, title: { equals: value } },
      page_size: 1,
    });
    return response.results[0] || null;
  }

  async _queryAll(dataSourceId, filter) {
    const results = [];
    let cursor;
    do {
      const response = await this.client.dataSources.query({
        data_source_id: dataSourceId,
        ...(filter ? { filter } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
        page_size: 100,
      });
      results.push(...response.results);
      cursor = response.has_more ? response.next_cursor : undefined;
    } while (cursor);
    return results;
  }

  // IDs are assigned by scanning existing titles rather than by a counter
  // property, since Notion has no atomic sequence primitive -- fine at demo
  // volume, and the production repository won't need this at all (Postgres
  // gets a real sequence or a UUID default).
  async _nextSequentialId(dataSourceId, titleProperty, prefix) {
    const pages = await this._queryAll(dataSourceId);
    let max = 0;
    for (const page of pages) {
      const title = titleText(page, titleProperty);
      if (title.startsWith(prefix) && /^\d+$/.test(title.slice(prefix.length))) {
        max = Math.max(max, parseInt(title.slice(prefix.length), 10));
      }
    }
    return `${prefix}${String(max + 1).padStart(3, "0")}`;
  }
}
