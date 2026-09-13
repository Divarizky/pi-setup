import assert from "node:assert/strict";
import test from "node:test";
import { isInsideProject } from "./security.ts";

test("isInsideProject: root dan child lolos", () => {
  assert.equal(isInsideProject("/a/b", "/a/b"), true);
  assert.equal(isInsideProject("/a/b", "/a/b/c"), true);
  assert.equal(isInsideProject("/a/b", "/a/b/c/d.txt"), true);
});

test("isInsideProject: escape .. ditolak", () => {
  assert.equal(isInsideProject("/a/b", "/a/b/../c"), false);
  assert.equal(isInsideProject("/a/b", "/a"), false);
  assert.equal(isInsideProject("/a/b", "/"), false);
});

test("isInsideProject: normalisasi slash vs backslash", () => {
  // relative bisa pakai "/" di Windows; normalisasi harus tetap tolak escape
  assert.equal(isInsideProject("/a/b", "/a/b\\../c"), false);
});

test("isInsideProject: prefix mirip tapi beda folder ditolak", () => {
  assert.equal(isInsideProject("/a/b", "/a/bb/c"), false);
  assert.equal(isInsideProject("/a/b", "/a/bb"), false);
});
