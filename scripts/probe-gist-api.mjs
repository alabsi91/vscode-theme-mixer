// Exercises every function of src/sync/github-gist-client.ts against the real GitHub API, once, by hand.
// Never run from the extension. Needs a personal access token with the `gist` scope:
//
//   GITHUB_TOKEN=ghp_... node scripts/probe-gist-api.mjs
//
// Creates one secret gist named "vscode-theme-editor:probe", checks the facts the sync design depends on, and
// deletes the gist again.

import assert from "node:assert/strict";

import {
  createGist,
  deleteGist,
  findGistByDescription,
  readGist,
  readRawFile,
  updateGist,
} from "../src/sync/github-gist-client.ts";

const token = process.env.GITHUB_TOKEN;

if (!token) {
  console.error("Set GITHUB_TOKEN to a personal access token with the gist scope.");
  process.exit(1);
}

const PROBE_DESCRIPTION = "vscode-theme-editor:probe";

function expectOk(result, what) {
  if (!result.ok) {
    throw new Error(`${what} failed: HTTP ${result.status} ${result.message}`);
  }

  return result.value;
}

const gistId = expectOk(
  await createGist(token, PROBE_DESCRIPTION, { "a.json": { content: '{"a":1}' }, "b.json": { content: '{"b":1}' } }),
  "createGist"
);

console.log(`created probe gist ${gistId}`);

try {
  const foundGistId = expectOk(await findGistByDescription(token, PROBE_DESCRIPTION), "findGistByDescription");
  assert.equal(foundGistId, gistId);
  console.log("✔ findGistByDescription finds it");

  const firstRead = expectOk(await readGist(token, gistId), "readGist");
  assert.equal(firstRead.notModified, false);
  assert.ok(firstRead.gist.etag, "the response carries an ETag");

  const secondRead = expectOk(await readGist(token, gistId, firstRead.gist.etag), "readGist with If-None-Match");
  assert.equal(secondRead.notModified, true, "If-None-Match answers 304");
  console.log("✔ readGist: ETag round-trips as a 304");

  expectOk(await updateGist(token, gistId, { "a.json": { content: '{"a":2}' }, "b.json": null }), "updateGist");

  const afterPatch = expectOk(await readGist(token, gistId), "readGist after PATCH");
  assert.equal(afterPatch.notModified, false);
  assert.equal(afterPatch.gist.files["a.json"]?.content, '{"a":2}', "a.json was changed");
  assert.equal(afterPatch.gist.files["b.json"], undefined, "b.json was deleted");
  console.log("✔ updateGist: a content change and a null delete land in one PATCH");

  const hundredKilobytes = JSON.stringify({ padding: "x".repeat(100 * 1024) });
  expectOk(await updateGist(token, gistId, { "big.json": { content: hundredKilobytes } }), "updateGist 100KB");

  const afterBig = expectOk(await readGist(token, gistId), "readGist 100KB");
  assert.equal(afterBig.notModified, false);
  assert.equal(afterBig.gist.files["big.json"]?.truncated, false, "a 100KB file is not truncated");
  assert.equal(afterBig.gist.files["big.json"]?.content?.length, hundredKilobytes.length);
  console.log("✔ a 100KB file comes back whole");

  const twoMegabytes = JSON.stringify({ padding: "y".repeat(2 * 1024 * 1024) });
  expectOk(await updateGist(token, gistId, { "huge.json": { content: twoMegabytes } }), "updateGist 2MB");

  const afterHuge = expectOk(await readGist(token, gistId), "readGist 2MB");
  assert.equal(afterHuge.notModified, false);
  assert.equal(afterHuge.gist.files["huge.json"]?.truncated, true, "a 2MB file is truncated");

  const rawContent = expectOk(await readRawFile(token, afterHuge.gist.files["huge.json"].rawUrl), "readRawFile");
  assert.equal(rawContent.length, twoMegabytes.length, "raw_url hands over the whole file");
  console.log("✔ a truncated file is whole at raw_url");

  const emptyContentResult = await updateGist(token, gistId, { "empty.json": { content: "" } });

  if (emptyContentResult.ok) {
    console.log("ℹ empty content was accepted. The client never sends it, so nothing changes.");
  } else {
    console.log(`✔ empty content is rejected: HTTP ${emptyContentResult.status} ${emptyContentResult.message}`);
  }
} finally {
  expectOk(await deleteGist(token, gistId), "deleteGist");
  console.log("✔ deleteGist, probe gist removed");
}
