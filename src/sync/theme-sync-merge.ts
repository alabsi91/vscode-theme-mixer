import type { ColorThemeDocument } from "../theme/generated-theme-file.ts";
import type { RevisionVector, ThemeIndex, ThemeIndexEntry } from "../theme/theme-storage.ts";

export const THEME_INDEX_VERSION = 1;

const TOMBSTONE_LIFETIME_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

const FUTURE_CLOCK_TOLERANCE_MILLISECONDS = 24 * 60 * 60 * 1000;

export interface MergeInput {
  local: ThemeIndex;
  remote: ThemeIndex;
  machineId: string;
  readLocalDocument: (savedThemeId: string) => Promise<ColorThemeDocument | undefined>;
  readRemoteDocument: (savedThemeId: string) => Promise<ColorThemeDocument | undefined>;
  /** ISO 8601. Injected so tests are deterministic. */
  now: string;
  createId: () => string;
}

export interface SyncPlanThemeWrite {
  id: string;
  document: ColorThemeDocument;
  entry: ThemeIndexEntry;
}

export interface SyncPlanThemeDelete {
  id: string;
  /** The tombstone. */
  entry: ThemeIndexEntry;
}

export interface SyncPlanConflictCopy extends SyncPlanThemeWrite {
  copiedFromId: string;
}

export interface SyncPlanSkippedTheme {
  id: string;
  /** From the local copy, when there is one. */
  name: string | undefined;
}

export interface SyncPlan {
  writeLocal: SyncPlanThemeWrite[];
  deleteLocal: SyncPlanThemeDelete[];
  pushRemote: SyncPlanThemeWrite[];
  /** The file is removed. The tombstone stays in `nextRemoteIndex`. */
  deleteRemote: string[];
  /** Written locally and pushed. */
  conflictCopies: SyncPlanConflictCopy[];
  /** Live in the gist but unreadable from it. Left alone on both sides. */
  skipped: SyncPlanSkippedTheme[];
  nextLocalIndex: ThemeIndex;
  nextRemoteIndex: ThemeIndex;
}

export class UnsupportedIndexVersionError extends Error {
  constructor(version: number) {
    super(`The index was written by a newer Theme Editor (version ${version}).`);
    this.name = "UnsupportedIndexVersionError";
  }
}

export function createEmptyThemeIndex(): ThemeIndex {
  return { version: THEME_INDEX_VERSION, themes: {} };
}

// ---------------------------------------------------------------------------------------------
// Revision vectors

export function getRevisionCount(vector: RevisionVector, machineId: string): number {
  return vector[machineId] ?? 0;
}

export function areRevisionVectorsEqual(left: RevisionVector, right: RevisionVector): boolean {
  return getMachineIds(left, right).every(machineId => getRevisionCount(left, machineId) === getRevisionCount(right, machineId));
}

/** True when `left` has seen every write in `right` and at least one more. */
export function isRevisionVectorAhead(left: RevisionVector, right: RevisionVector): boolean {
  const machineIds = getMachineIds(left, right);

  const hasEveryWrite = machineIds.every(machineId => getRevisionCount(left, machineId) >= getRevisionCount(right, machineId));
  const hasMoreWrites = machineIds.some(machineId => getRevisionCount(left, machineId) > getRevisionCount(right, machineId));

  return hasEveryWrite && hasMoreWrites;
}

export function areRevisionVectorsConcurrent(left: RevisionVector, right: RevisionVector): boolean {
  if (areRevisionVectorsEqual(left, right)) {
    return false;
  }

  return !isRevisionVectorAhead(left, right) && !isRevisionVectorAhead(right, left);
}

/** Componentwise maximum. */
export function mergeRevisionVectors(left: RevisionVector, right: RevisionVector): RevisionVector {
  const merged: RevisionVector = {};

  for (const machineId of getMachineIds(left, right)) {
    merged[machineId] = Math.max(getRevisionCount(left, machineId), getRevisionCount(right, machineId));
  }

  return merged;
}

export function bumpRevisionVector(vector: RevisionVector, machineId: string): RevisionVector {
  return { ...vector, [machineId]: getRevisionCount(vector, machineId) + 1 };
}

function getMachineIds(left: RevisionVector, right: RevisionVector): string[] {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])];
}

// ---------------------------------------------------------------------------------------------
// Entries and documents

export function isTombstone(entry: ThemeIndexEntry): boolean {
  return entry.deletedAt !== undefined;
}

/** A `deletedAt` more than a day in the future counts as now. */
export function isTombstoneExpired(entry: ThemeIndexEntry, nowMilliseconds: number): boolean {
  if (entry.deletedAt === undefined) {
    return false;
  }

  const deletedAtMilliseconds = Date.parse(entry.deletedAt);
  if (Number.isNaN(deletedAtMilliseconds)) {
    return false;
  }

  const isFarInTheFuture = deletedAtMilliseconds > nowMilliseconds + FUTURE_CLOCK_TOLERANCE_MILLISECONDS;
  const clampedDeletedAtMilliseconds = isFarInTheFuture ? nowMilliseconds : deletedAtMilliseconds;

  return nowMilliseconds - clampedDeletedAtMilliseconds > TOMBSTONE_LIFETIME_MILLISECONDS;
}

/** Object keys sorted at every level. Arrays keep their order, because `tokenColors` is ordered. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value)) ?? "";
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sortObjectKeys(item));
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).toSorted((left, right) => left.localeCompare(right));

  return Object.fromEntries(sortedKeys.map(key => [key, sortObjectKeys(record[key])]));
}

// ---------------------------------------------------------------------------------------------
// The merge

export async function createSyncPlan(input: MergeInput): Promise<SyncPlan> {
  if (input.remote.version > THEME_INDEX_VERSION) {
    throw new UnsupportedIndexVersionError(input.remote.version);
  }

  const plan: SyncPlan = {
    writeLocal: [],
    deleteLocal: [],
    pushRemote: [],
    deleteRemote: [],
    conflictCopies: [],
    skipped: [],
    nextLocalIndex: createEmptyThemeIndex(),
    nextRemoteIndex: createEmptyThemeIndex(),
  };

  const nowMilliseconds = Date.parse(input.now);
  const savedThemeIds = new Set([...Object.keys(input.local.themes), ...Object.keys(input.remote.themes)]);

  for (const savedThemeId of savedThemeIds) {
    // An expired tombstone is treated as missing on its side, and is never written into either next index.
    const localEntry = getUnexpiredEntry(input.local.themes[savedThemeId], nowMilliseconds);
    const remoteEntry = getUnexpiredEntry(input.remote.themes[savedThemeId], nowMilliseconds);

    await mergeSavedTheme(savedThemeId, localEntry, remoteEntry, input, plan);
  }

  return plan;
}

export function willSyncPlanChangeGist(plan: SyncPlan, remoteIndexInGist: ThemeIndex): boolean {
  if (plan.pushRemote.length > 0 || plan.deleteRemote.length > 0 || plan.conflictCopies.length > 0) {
    return true;
  }

  return canonicalJson(plan.nextRemoteIndex) !== canonicalJson(remoteIndexInGist);
}

function getUnexpiredEntry(entry: ThemeIndexEntry | undefined, nowMilliseconds: number): ThemeIndexEntry | undefined {
  if (entry === undefined || isTombstoneExpired(entry, nowMilliseconds)) {
    return undefined;
  }

  return entry;
}

async function mergeSavedTheme(
  savedThemeId: string,
  localEntryOrUndefined: ThemeIndexEntry | undefined,
  remoteEntry: ThemeIndexEntry | undefined,
  input: MergeInput,
  plan: SyncPlan
): Promise<void> {
  let localEntry = localEntryOrUndefined;

  const setBothEntries = (entry: ThemeIndexEntry) => {
    plan.nextLocalIndex.themes[savedThemeId] = entry;
    plan.nextRemoteIndex.themes[savedThemeId] = entry;
  };

  // row 5
  if (localEntry && remoteEntry && areRevisionVectorsEqual(localEntry.revisions, remoteEntry.revisions)) {
    plan.nextLocalIndex.themes[savedThemeId] = localEntry;
    plan.nextRemoteIndex.themes[savedThemeId] = remoteEntry;
    return;
  }

  const localDocument = localEntry && !isTombstone(localEntry) ? await input.readLocalDocument(savedThemeId) : undefined;
  const remoteDocument = remoteEntry && !isTombstone(remoteEntry) ? await input.readRemoteDocument(savedThemeId) : undefined;

  // The gist lists it but will not hand it over. Both sides stay as they are.
  if (remoteEntry && !isTombstone(remoteEntry) && !remoteDocument) {
    if (localEntry) {
      plan.nextLocalIndex.themes[savedThemeId] = localEntry;
    }

    plan.nextRemoteIndex.themes[savedThemeId] = remoteEntry;
    plan.skipped.push({ id: savedThemeId, name: localDocument?.name });
    return;
  }

  // A live entry whose file is gone. The migration drops those too, and the next sync brings the theme back.
  if (localEntry && !isTombstone(localEntry) && !localDocument) {
    localEntry = undefined;
  }

  if (!localEntry && !remoteEntry) return;

  // rows 1 and 2
  if (localEntry && !remoteEntry) {
    if (localDocument) {
      plan.pushRemote.push({ id: savedThemeId, document: localDocument, entry: localEntry });
    }

    setBothEntries(localEntry);
    return;
  }

  // rows 3 and 4
  if (!localEntry && remoteEntry) {
    if (remoteDocument) {
      plan.writeLocal.push({ id: savedThemeId, document: remoteDocument, entry: remoteEntry });
    }

    setBothEntries(remoteEntry);
    return;
  }

  if (!localEntry || !remoteEntry) return;

  // row 6
  if (isRevisionVectorAhead(localEntry.revisions, remoteEntry.revisions)) {
    if (localDocument) {
      plan.pushRemote.push({ id: savedThemeId, document: localDocument, entry: localEntry });
    } else {
      plan.deleteRemote.push(savedThemeId);
    }

    setBothEntries(localEntry);
    return;
  }

  // row 7
  if (isRevisionVectorAhead(remoteEntry.revisions, localEntry.revisions)) {
    if (remoteDocument) {
      plan.writeLocal.push({ id: savedThemeId, document: remoteDocument, entry: remoteEntry });
    } else {
      plan.deleteLocal.push({ id: savedThemeId, entry: remoteEntry });
    }

    setBothEntries(remoteEntry);
    return;
  }

  const mergedRevisions = mergeRevisionVectors(localEntry.revisions, remoteEntry.revisions);

  if (localDocument && remoteDocument) {
    // row 8
    if (canonicalJson(localDocument) === canonicalJson(remoteDocument)) {
      const laterEntry = isUpdatedAtOrAfter(localEntry, remoteEntry) ? localEntry : remoteEntry;
      setBothEntries({ ...laterEntry, revisions: mergedRevisions });
      return;
    }

    // row 9. The only place a wall clock decides anything, and it only decides who keeps the name.
    const isLocalWinner = isUpdatedAtOrAfter(localEntry, remoteEntry);
    const winnerEntry: ThemeIndexEntry = {
      ...(isLocalWinner ? localEntry : remoteEntry),
      revisions: bumpRevisionVector(mergedRevisions, input.machineId),
    };

    if (isLocalWinner) {
      plan.pushRemote.push({ id: savedThemeId, document: localDocument, entry: winnerEntry });
    } else {
      plan.writeLocal.push({ id: savedThemeId, document: remoteDocument, entry: winnerEntry });
    }

    setBothEntries(winnerEntry);

    const loserEntry = isLocalWinner ? remoteEntry : localEntry;
    const loserDocument = isLocalWinner ? remoteDocument : localDocument;

    const conflictCopy: SyncPlanConflictCopy = {
      id: input.createId(),
      document: { ...loserDocument, name: `${loserDocument.name} (conflict)` },
      entry: {
        revisions: bumpRevisionVector({}, input.machineId),
        updatedAt: input.now,
        takenFromSources: loserEntry.takenFromSources,
      },
      copiedFromId: savedThemeId,
    };

    plan.conflictCopies.push(conflictCopy);
    plan.nextLocalIndex.themes[conflictCopy.id] = conflictCopy.entry;
    plan.nextRemoteIndex.themes[conflictCopy.id] = conflictCopy.entry;
    return;
  }

  // row 10. An edit concurrent with a delete is a deliberate keep.
  if (localDocument || remoteDocument) {
    const liveEntry = localDocument ? localEntry : remoteEntry;
    const keptEntry: ThemeIndexEntry = { ...liveEntry, revisions: bumpRevisionVector(mergedRevisions, input.machineId) };

    if (localDocument) {
      plan.pushRemote.push({ id: savedThemeId, document: localDocument, entry: keptEntry });
    } else if (remoteDocument) {
      plan.writeLocal.push({ id: savedThemeId, document: remoteDocument, entry: keptEntry });
    }

    setBothEntries(keptEntry);
    return;
  }

  // row 11
  const laterTombstone =
    Date.parse(localEntry.deletedAt ?? "") >= Date.parse(remoteEntry.deletedAt ?? "") ? localEntry : remoteEntry;
  setBothEntries({ ...laterTombstone, revisions: mergedRevisions });
}

function isUpdatedAtOrAfter(entry: ThemeIndexEntry, other: ThemeIndexEntry): boolean {
  return Date.parse(entry.updatedAt) >= Date.parse(other.updatedAt);
}
