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

function titleText(page, property) {
  return page.properties[property]?.title?.[0]?.plain_text || "";
}

function richText(page, property) {
  return page.properties[property]?.rich_text?.[0]?.plain_text || "";
}

function dateValue(page, property) {
  return page.properties[property]?.date?.start || null;
}

function selectValue(page, property) {
  return page.properties[property]?.select?.name || null;
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

export class NotionRepository extends Repository {
  /**
   * @param {{ client: import("@notionhq/client").Client,
   *   patientsDataSourceId: string, casesDataSourceId: string }} config
   */
  constructor({ client, patientsDataSourceId, casesDataSourceId }) {
    super();
    if (!client) throw new NotionRepositoryError("NotionRepository requires a Notion client.");
    if (!patientsDataSourceId) throw new NotionRepositoryError("NotionRepository requires patientsDataSourceId.");
    if (!casesDataSourceId) throw new NotionRepositoryError("NotionRepository requires casesDataSourceId.");
    this.client = client;
    this.patientsDataSourceId = patientsDataSourceId;
    this.casesDataSourceId = casesDataSourceId;
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
