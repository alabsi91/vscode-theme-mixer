import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UnsupportedIndexVersionError,
  areRevisionVectorsConcurrent,
  areRevisionVectorsEqual,
  canonicalJson,
  createSyncPlan,
  isRevisionVectorAhead,
  isTombstoneExpired,
  mergeRevisionVectors,
} from "./theme-sync-merge.ts";

import type { MergeInput, SyncPlan } from "./theme-sync-merge.ts";
import type { ColorThemeDocument } from "../theme/generated-theme-file.ts";
import type { ThemeIndex, ThemeIndexEntry } from "../theme/theme-storage.ts";

// Run with: node --test src/sync/theme-sync-merge.test.ts

const NOW = "2026-09-05T12:00:00.000Z";

const EARLIER = "2026-09-05T11:00:00.000Z";

const LATER = "2026-09-05T13:00:00.000Z";

const THEME_ID = "11111111-1111-4111-8111-111111111111";

const COPY_ID = "22222222-2222-4222-8222-222222222222";

function createDocument(name: string, background = "#000000"): ColorThemeDocument {
  return {
    name,
    type: "dark",
    semanticHighlighting: true,
    colors: { "editor.background": background },
    semanticTokenColors: {},
    tokenColors: [],
  };
}

function createEntry(revisions: Record<string, number>, options?: { updatedAt?: string; deletedAt?: string }): ThemeIndexEntry {
  return { revisions, updatedAt: options?.updatedAt ?? NOW, deletedAt: options?.deletedAt, takenFromSources: {} };
}

function createIndex(themes: Record<string, ThemeIndexEntry> = {}): ThemeIndex {
  return { version: 1, themes };
}

interface MergeScenario {
  local?: ThemeIndex;
  remote?: ThemeIndex;
  localDocuments?: Record<string, ColorThemeDocument>;
  remoteDocuments?: Record<string, ColorThemeDocument>;
  now?: string;
}

function merge(scenario: MergeScenario): Promise<SyncPlan> {
  const input: MergeInput = {
    local: scenario.local ?? createIndex(),
    remote: scenario.remote ?? createIndex(),
    machineId: "B",
    readLocalDocument: id => Promise.resolve(scenario.localDocuments?.[id]),
    readRemoteDocument: id => Promise.resolve(scenario.remoteDocuments?.[id]),
    now: scenario.now ?? NOW,
    createId: () => COPY_ID,
  };

  return createSyncPlan(input);
}

function getIds(writes: Array<{ id: string }>): string[] {
  return writes.map(write => write.id);
}

// ---------------------------------------------------------------------------------------------
// Vectors

test("vectors compare componentwise, with a missing machine counting as zero", () => {
  assert.equal(areRevisionVectorsEqual({ A: 1 }, { A: 1, B: 0 }), true);
  assert.equal(areRevisionVectorsEqual({ A: 1 }, { A: 2 }), false);

  assert.equal(isRevisionVectorAhead({ A: 2 }, { A: 1 }), true);
  assert.equal(isRevisionVectorAhead({ A: 1, B: 1 }, { A: 1 }), true);
  assert.equal(isRevisionVectorAhead({ A: 1 }, { A: 1 }), false);
  assert.equal(isRevisionVectorAhead({ A: 2 }, { A: 1, B: 1 }), false);

  assert.equal(areRevisionVectorsConcurrent({ A: 2 }, { A: 1, B: 1 }), true);
  assert.equal(areRevisionVectorsConcurrent({ A: 2 }, { A: 2 }), false);
  assert.equal(areRevisionVectorsConcurrent({ A: 2 }, { A: 1 }), false);

  assert.deepEqual(mergeRevisionVectors({ A: 2 }, { A: 1, B: 1 }), { A: 2, B: 1 });
});

// ---------------------------------------------------------------------------------------------
// Rows

test("row 1: only local and live is pushed", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ B: 1 }) }),
    localDocuments: { [THEME_ID]: createDocument("Mine") },
  });

  assert.deepEqual(getIds(plan.pushRemote), [THEME_ID]);
  assert.deepEqual(plan.nextRemoteIndex.themes[THEME_ID]?.revisions, { B: 1 });
  assert.deepEqual(plan.nextLocalIndex.themes[THEME_ID]?.revisions, { B: 1 });
});

test("row 2: only local and a tombstone goes into the remote index without a file", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ B: 2 }, { deletedAt: NOW }) }),
  });

  assert.equal(plan.pushRemote.length, 0);
  assert.equal(plan.deleteRemote.length, 0);
  assert.equal(plan.nextRemoteIndex.themes[THEME_ID]?.deletedAt, NOW);
});

test("row 3: only remote and live is pulled", async () => {
  const plan = await merge({
    remote: createIndex({ [THEME_ID]: createEntry({ A: 1 }) }),
    remoteDocuments: { [THEME_ID]: createDocument("Theirs") },
  });

  assert.deepEqual(getIds(plan.writeLocal), [THEME_ID]);
  assert.deepEqual(plan.nextLocalIndex.themes[THEME_ID]?.revisions, { A: 1 });
});

test("row 4: only remote and a tombstone is copied into the local index", async () => {
  const plan = await merge({
    remote: createIndex({ [THEME_ID]: createEntry({ A: 2 }, { deletedAt: NOW }) }),
  });

  assert.equal(plan.writeLocal.length, 0);
  assert.equal(plan.deleteLocal.length, 0);
  assert.equal(plan.nextLocalIndex.themes[THEME_ID]?.deletedAt, NOW);
});

test("row 5: equal vectors change nothing", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 1, B: 1 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 1, B: 1 }) }),
    localDocuments: { [THEME_ID]: createDocument("Same") },
    remoteDocuments: { [THEME_ID]: createDocument("Different but never read") },
  });

  assert.equal(plan.writeLocal.length + plan.pushRemote.length + plan.conflictCopies.length, 0);
  assert.deepEqual(plan.nextLocalIndex.themes[THEME_ID]?.revisions, { A: 1, B: 1 });
});

test("row 6: a dominating local live entry is pushed, a dominating local tombstone removes the remote file", async () => {
  const livePlan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 1, B: 1 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 1 }) }),
    localDocuments: { [THEME_ID]: createDocument("Mine") },
    remoteDocuments: { [THEME_ID]: createDocument("Theirs") },
  });

  assert.deepEqual(getIds(livePlan.pushRemote), [THEME_ID]);
  assert.equal(livePlan.writeLocal.length, 0);

  const tombstonePlan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 1, B: 1 }, { deletedAt: NOW }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 1 }) }),
    remoteDocuments: { [THEME_ID]: createDocument("Theirs") },
  });

  assert.deepEqual(tombstonePlan.deleteRemote, [THEME_ID]);
  assert.equal(tombstonePlan.nextRemoteIndex.themes[THEME_ID]?.deletedAt, NOW);
});

test("row 6: a remote rolled back by a stale PATCH is pushed over, never pulled", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 7 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 6 }) }),
    localDocuments: { [THEME_ID]: createDocument("Newer") },
    remoteDocuments: { [THEME_ID]: createDocument("Rolled back") },
  });

  assert.deepEqual(getIds(plan.pushRemote), [THEME_ID]);
  assert.equal(plan.writeLocal.length, 0);
  assert.deepEqual(plan.nextRemoteIndex.themes[THEME_ID]?.revisions, { A: 7 });
});

test("row 7: a dominating remote live entry is pulled, a dominating remote tombstone deletes locally", async () => {
  const livePlan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 1 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 2 }) }),
    localDocuments: { [THEME_ID]: createDocument("Old") },
    remoteDocuments: { [THEME_ID]: createDocument("New") },
  });

  assert.deepEqual(getIds(livePlan.writeLocal), [THEME_ID]);
  assert.equal(livePlan.writeLocal[0]?.document.name, "New");

  const tombstonePlan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 1 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 2 }, { deletedAt: NOW }) }),
    localDocuments: { [THEME_ID]: createDocument("Old") },
  });

  assert.deepEqual(getIds(tombstonePlan.deleteLocal), [THEME_ID]);
  assert.equal(tombstonePlan.nextLocalIndex.themes[THEME_ID]?.deletedAt, NOW);
});

test("row 8: concurrent but identical documents merge their vectors with no file writes", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ B: 1 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 1 }) }),
    localDocuments: { [THEME_ID]: createDocument("Same") },
    remoteDocuments: { [THEME_ID]: createDocument("Same") },
  });

  assert.equal(plan.writeLocal.length + plan.pushRemote.length + plan.conflictCopies.length, 0);
  assert.deepEqual(plan.nextLocalIndex.themes[THEME_ID]?.revisions, { A: 1, B: 1 });
  assert.deepEqual(plan.nextRemoteIndex.themes[THEME_ID]?.revisions, { A: 1, B: 1 });
});

test("row 9: concurrent different documents keep the later one and copy the other", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ B: 1 }, { updatedAt: EARLIER }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 1 }, { updatedAt: LATER }) }),
    localDocuments: { [THEME_ID]: createDocument("Mine", "#111111") },
    remoteDocuments: { [THEME_ID]: createDocument("Theirs", "#222222") },
  });

  assert.deepEqual(getIds(plan.writeLocal), [THEME_ID]);
  assert.equal(plan.writeLocal[0]?.document.name, "Theirs");
  assert.deepEqual(plan.writeLocal[0]?.entry.revisions, { A: 1, B: 2 });

  assert.equal(plan.conflictCopies.length, 1);
  assert.equal(plan.conflictCopies[0]?.id, COPY_ID);
  assert.equal(plan.conflictCopies[0]?.document.name, "Mine (conflict)");
  assert.equal(plan.conflictCopies[0]?.copiedFromId, THEME_ID);
  assert.deepEqual(plan.conflictCopies[0]?.entry.revisions, { B: 1 });

  assert.ok(plan.nextLocalIndex.themes[COPY_ID]);
  assert.ok(plan.nextRemoteIndex.themes[COPY_ID]);
});

test("row 9: a conflict tie keeps local and copies remote", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ B: 1 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 1 }) }),
    localDocuments: { [THEME_ID]: createDocument("Mine", "#111111") },
    remoteDocuments: { [THEME_ID]: createDocument("Theirs", "#222222") },
  });

  assert.deepEqual(getIds(plan.pushRemote), [THEME_ID]);
  assert.equal(plan.pushRemote[0]?.document.name, "Mine");
  assert.equal(plan.writeLocal.length, 0);
  assert.equal(plan.conflictCopies[0]?.document.name, "Theirs (conflict)");
});

test("row 10: an edit concurrent with a delete keeps the edit, both directions", async () => {
  const localLivePlan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 1, B: 1 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 2 }, { deletedAt: NOW }) }),
    localDocuments: { [THEME_ID]: createDocument("Kept") },
  });

  assert.deepEqual(getIds(localLivePlan.pushRemote), [THEME_ID]);
  assert.equal(localLivePlan.deleteLocal.length, 0);
  assert.equal(localLivePlan.nextRemoteIndex.themes[THEME_ID]?.deletedAt, undefined);
  assert.deepEqual(localLivePlan.nextRemoteIndex.themes[THEME_ID]?.revisions, { A: 2, B: 2 });

  const remoteLivePlan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 1, B: 1 }, { deletedAt: NOW }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 2 }) }),
    remoteDocuments: { [THEME_ID]: createDocument("Kept") },
  });

  assert.deepEqual(getIds(remoteLivePlan.writeLocal), [THEME_ID]);
  assert.equal(remoteLivePlan.deleteRemote.length, 0);
  assert.equal(remoteLivePlan.nextLocalIndex.themes[THEME_ID]?.deletedAt, undefined);
});

test("row 11: two concurrent tombstones keep the later deletedAt", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ B: 2 }, { deletedAt: EARLIER }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 2 }, { deletedAt: LATER }) }),
  });

  assert.equal(plan.nextLocalIndex.themes[THEME_ID]?.deletedAt, LATER);
  assert.deepEqual(plan.nextLocalIndex.themes[THEME_ID]?.revisions, { A: 2, B: 2 });
});

// ---------------------------------------------------------------------------------------------
// Scenarios

test("the stale overwrite race loses nothing", async () => {
  // A and B both hold T at {A:6}. B edits, pushes. A edits, but read the gist before B's push.
  const documentByB = createDocument("T", "#b00000");
  const documentByA = createDocument("T", "#a00000");

  const planOnA = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 7 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 6 }) }),
    localDocuments: { [THEME_ID]: documentByA },
    remoteDocuments: { [THEME_ID]: documentByB },
  });

  assert.deepEqual(getIds(planOnA.pushRemote), [THEME_ID]);

  // B's next run sees A's push over its own.
  const planOnB = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 6, B: 1 }, { updatedAt: EARLIER }) }),
    remote: planOnA.nextRemoteIndex,
    localDocuments: { [THEME_ID]: documentByB },
    remoteDocuments: { [THEME_ID]: documentByA },
  });

  assert.equal(planOnB.writeLocal[0]?.document.colors["editor.background"], "#a00000");
  assert.equal(planOnB.conflictCopies[0]?.document.colors["editor.background"], "#b00000");
  assert.equal(planOnB.conflictCopies[0]?.document.name, "T (conflict)");
});

test("the first sync of two machines holding identical themes merges the vectors", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ B: 1 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 1 }) }),
    localDocuments: { [THEME_ID]: createDocument("Same") },
    remoteDocuments: { [THEME_ID]: createDocument("Same") },
  });

  assert.deepEqual(plan.nextLocalIndex.themes[THEME_ID]?.revisions, { A: 1, B: 1 });
  assert.equal(plan.writeLocal.length + plan.pushRemote.length, 0);
});

test("a live local entry whose file is gone is dropped, and comes back from the gist", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ A: 2, B: 1 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 2 }) }),
    remoteDocuments: { [THEME_ID]: createDocument("Theirs") },
  });

  assert.deepEqual(getIds(plan.writeLocal), [THEME_ID]);
  assert.deepEqual(plan.nextLocalIndex.themes[THEME_ID]?.revisions, { A: 2 });
});

test("a remote theme that cannot be read is skipped and left alone on both sides", async () => {
  const plan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ B: 1 }) }),
    remote: createIndex({ [THEME_ID]: createEntry({ A: 1 }) }),
    localDocuments: { [THEME_ID]: createDocument("Mine") },
  });

  assert.deepEqual(plan.skipped, [{ id: THEME_ID, name: "Mine" }]);
  assert.deepEqual(plan.nextLocalIndex.themes[THEME_ID]?.revisions, { B: 1 });
  assert.deepEqual(plan.nextRemoteIndex.themes[THEME_ID]?.revisions, { A: 1 });
  assert.equal(plan.writeLocal.length + plan.pushRemote.length + plan.conflictCopies.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Documents

test("canonicalJson ignores key order and respects tokenColors order", () => {
  const left = { b: 1, a: { d: 2, c: 3 }, tokenColors: [{ scope: "x" }, { scope: "y" }] };
  const right = { a: { c: 3, d: 2 }, tokenColors: [{ scope: "x" }, { scope: "y" }], b: 1 };
  const reordered = { ...right, tokenColors: [{ scope: "y" }, { scope: "x" }] };

  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.notEqual(canonicalJson(left), canonicalJson(reordered));
});

// ---------------------------------------------------------------------------------------------
// Tombstones

test("an expired tombstone is dropped, not pushed, not adopted", async () => {
  const fortyDaysAgo = new Date(Date.parse(NOW) - 40 * 24 * 60 * 60 * 1000).toISOString();

  const localPlan = await merge({
    local: createIndex({ [THEME_ID]: createEntry({ B: 2 }, { deletedAt: fortyDaysAgo }) }),
  });

  assert.equal(localPlan.nextLocalIndex.themes[THEME_ID], undefined);
  assert.equal(localPlan.nextRemoteIndex.themes[THEME_ID], undefined);

  const remotePlan = await merge({
    remote: createIndex({ [THEME_ID]: createEntry({ A: 2 }, { deletedAt: fortyDaysAgo }) }),
  });

  assert.equal(remotePlan.nextLocalIndex.themes[THEME_ID], undefined);
  assert.equal(remotePlan.nextRemoteIndex.themes[THEME_ID], undefined);
});

test("a deletedAt far in the future is clamped to now", () => {
  const nowMilliseconds = Date.parse(NOW);
  const farFuture = new Date(nowMilliseconds + 400 * 24 * 60 * 60 * 1000).toISOString();

  assert.equal(isTombstoneExpired(createEntry({ A: 1 }, { deletedAt: farFuture }), nowMilliseconds), false);
  assert.equal(isTombstoneExpired(createEntry({ A: 1 }, { deletedAt: farFuture }), nowMilliseconds + 31 * 24 * 60 * 60 * 1000), false);
  assert.equal(isTombstoneExpired(createEntry({ A: 1 }, { deletedAt: NOW }), nowMilliseconds + 31 * 24 * 60 * 60 * 1000), true);
});

// ---------------------------------------------------------------------------------------------
// Version

test("a newer remote index version is refused", async () => {
  await assert.rejects(merge({ remote: { version: 2, themes: {} } }), UnsupportedIndexVersionError);
});
