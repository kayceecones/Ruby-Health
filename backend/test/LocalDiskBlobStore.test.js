import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { LocalDiskBlobStore, BlobStoreError } from "../src/repository/LocalDiskBlobStore.js";

async function makeStore() {
  const baseDir = await mkdtemp(path.join(tmpdir(), "ruby-blob-test-"));
  return { store: new LocalDiskBlobStore({ baseDir }), baseDir };
}

test("a blob written can be read back byte-for-byte", async () => {
  const { store, baseDir } = await makeStore();
  try {
    const storageRef = await store.putBlob("documents/D001/original.pdf", Buffer.from("%PDF-1.4 fake content"));
    assert.equal(storageRef, "documents/D001/original.pdf");

    const content = await store.getBlob(storageRef);
    assert.equal(content.toString(), "%PDF-1.4 fake content");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("putBlob creates nested directories as needed", async () => {
  const { store, baseDir } = await makeStore();
  try {
    await store.putBlob("a/b/c/d.txt", "nested");
    assert.equal((await store.getBlob("a/b/c/d.txt")).toString(), "nested");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("getBlob rejects an unknown storageRef", async () => {
  const { store, baseDir } = await makeStore();
  try {
    await assert.rejects(() => store.getBlob("never-written.txt"), BlobStoreError);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("putBlob and getBlob reject a key that escapes the base directory", async () => {
  const { store, baseDir } = await makeStore();
  try {
    await assert.rejects(() => store.putBlob("../escape.txt", "x"), BlobStoreError);
    await assert.rejects(() => store.getBlob("../escape.txt"), BlobStoreError);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("putBlob rejects an empty key", async () => {
  const { store, baseDir } = await makeStore();
  try {
    await assert.rejects(() => store.putBlob("", "x"), BlobStoreError);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
