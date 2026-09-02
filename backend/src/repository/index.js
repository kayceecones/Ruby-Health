// Entry point for the persistence layer. Application code should import
// from here (or receive a Repository instance some other way) -- never
// import NotionRepository or @notionhq/client directly outside this
// directory. See Repository.js for why that boundary matters.

import { Client } from "@notionhq/client";
import { NotionRepository } from "./NotionRepository.js";

export { Repository, BlobStore, NotImplementedError } from "./Repository.js";
export { NotionRepository, NotionRepositoryError } from "./NotionRepository.js";

/** Builds a NotionRepository from the standard backend/.env variables. */
export function createNotionRepositoryFromEnv(env = process.env) {
  const apiKey = env.NOTION_API_KEY;
  const patientsDataSourceId = env.NOTION_PATIENTS_DATA_SOURCE_ID;
  const casesDataSourceId = env.NOTION_CASES_DATA_SOURCE_ID;
  const encountersDataSourceId = env.NOTION_ENCOUNTERS_DATA_SOURCE_ID;
  const artifactsDataSourceId = env.NOTION_ARTIFACTS_DATA_SOURCE_ID;
  const claimsDataSourceId = env.NOTION_CLAIMS_DATA_SOURCE_ID;

  const missing = [
    !apiKey && "NOTION_API_KEY",
    !patientsDataSourceId && "NOTION_PATIENTS_DATA_SOURCE_ID",
    !casesDataSourceId && "NOTION_CASES_DATA_SOURCE_ID",
    !encountersDataSourceId && "NOTION_ENCOUNTERS_DATA_SOURCE_ID",
    !artifactsDataSourceId && "NOTION_ARTIFACTS_DATA_SOURCE_ID",
    !claimsDataSourceId && "NOTION_CLAIMS_DATA_SOURCE_ID",
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Missing Notion repository config: ${missing.join(", ")}. Set these in backend/.env.`);
  }

  return new NotionRepository({
    client: new Client({ auth: apiKey }),
    patientsDataSourceId,
    casesDataSourceId,
    encountersDataSourceId,
    artifactsDataSourceId,
    claimsDataSourceId,
  });
}
