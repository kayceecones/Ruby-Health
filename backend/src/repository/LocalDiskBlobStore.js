// Demo-only BlobStore: files live on local disk. Render's disk is
// ephemeral (see providerProfiles.js for the same caveat), so nothing
// written here survives a redeploy -- fine for the synthetic demo,
// wrong for production. The Aptible-backed implementation is the seam
// this class exists to make swappable, not something built here yet.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BlobStore } from "./Repository.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE_DIR = path.join(__dirname, "..", "..", "data", "blobs");

export class BlobStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlobStoreError";
  }
}

export class LocalDiskBlobStore extends BlobStore {
  constructor({ baseDir = DEFAULT_BASE_DIR } = {}) {
    super();
    this.baseDir = path.resolve(baseDir);
  }

  // storageRef is the key itself -- there's no indirection to invent when
  // the whole store is one directory, and keeping them equal makes the
  // Postgres/S3 swap easier to reason about later (a storageRef there will
  // stop being a literal path, but this demo shouldn't pretend otherwise).
  async putBlob(key, content) {
    if (!key) throw new BlobStoreError("putBlob requires a non-empty key.");
    const filePath = this._resolve(key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
    return key;
  }

  async getBlob(storageRef) {
    if (!storageRef) throw new BlobStoreError("getBlob requires a non-empty storageRef.");
    const filePath = this._resolve(storageRef);
    try {
      return await readFile(filePath);
    } catch (err) {
      if (err.code === "ENOENT") throw new BlobStoreError(`No blob found for storageRef '${storageRef}'.`);
      throw err;
    }
  }

  // A key built from patient/document IDs is trusted-ish, not
  // user-supplied text -- but "trusted-ish" isn't "trusted," so this
  // still guards against a key that resolves outside baseDir.
  _resolve(key) {
    const resolved = path.resolve(this.baseDir, key);
    if (resolved !== this.baseDir && !resolved.startsWith(this.baseDir + path.sep)) {
      throw new BlobStoreError(`key '${key}' resolves outside the blob store's base directory.`);
    }
    return resolved;
  }
}
