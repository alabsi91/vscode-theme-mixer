import * as vscode from "vscode";

import { THEME_INDEX_VERSION, bumpRevisionVector, createEmptyThemeIndex, isTombstone } from "../sync/theme-sync-merge.ts";
import {
  classifyGeneratedThemeWriteError,
  createEmptyTheme,
  getErrorMessage,
  writeGeneratedTheme,
} from "./generated-theme-file.ts";

import type { SyncPlan } from "../sync/theme-sync-merge.ts";
import type { ColorThemeDocument, GeneratedThemeWriteFailureReason, ThemeBaseKind } from "./generated-theme-file.ts";

export interface SavedThemeSummary {
  id: string;
  name: string;
  base: ThemeBaseKind;
  lastModifiedAt: number;
}

export interface TakenFromSource {
  label: string;
  settingsId: string;
}

/** Machine id → how many writes that machine has made. Never reset, never decremented. */
export type RevisionVector = Record<string, number>;

export interface ThemeIndexEntry {
  revisions: RevisionVector;
  /** ISO 8601. Display and conflict tie-break only. */
  updatedAt: string;
  /** ISO 8601. Present means the theme is deleted and its file is gone. */
  deletedAt?: string;
  /** Keyed by take target id. */
  takenFromSources: Record<string, TakenFromSource>;
}

export interface ThemeIndex {
  version: number;
  /** Keyed by saved theme id. */
  themes: Record<string, ThemeIndexEntry>;
}

export type GeneratedThemeRestoreFailureReason =
  GeneratedThemeWriteFailureReason | "saved-theme-unreadable" | "theme-index-not-migrated";

export interface GeneratedThemeRestoreFailure {
  base?: ThemeBaseKind;
  reason: GeneratedThemeRestoreFailureReason;
  message: string;
}

/** Per base: the saved theme that took the deleted one's place, or null when none is left. */
export type ReplacementThemeByBase = Map<ThemeBaseKind, ColorThemeDocument | null>;

export const THEME_BASE_KINDS: ThemeBaseKind[] = ["dark", "light"];

const SAVED_THEMES_DIRECTORY_NAME = "themes";

const THEME_INDEX_FILE_NAME = "index.json";

const ACTIVE_SAVED_THEME_IDS_STATE_KEY = "activeSavedThemeIds";

const SYNC_MACHINE_ID_STATE_KEY = "syncMachineId";

const LEGACY_TAKEN_FROM_STATE_KEY = "takenFromLabels";

const SAVED_THEME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ActiveSavedThemeIds = Partial<Record<ThemeBaseKind, string>>;

type LegacyTakenFromSourcesBySavedThemeId = Record<string, Record<string, TakenFromSource>>;

const didWriteSavedThemes = new vscode.EventEmitter<void>();

/** Fires after every write that is not silent. Sync listens here. */
export const onDidWriteSavedThemes: vscode.Event<void> = didWriteSavedThemes.event;

let storageChain: Promise<unknown> = Promise.resolve();

/** Every write under `themes/` goes through here, one at a time. Silent writes do not fire `onDidWriteSavedThemes`. */
export function runStorageOperation<T>(operation: () => Promise<T>, options?: { isSilent: boolean }): Promise<T> {
  const result = storageChain.then(operation, operation);
  storageChain = result.catch(() => {});

  if (!options?.isSilent) {
    result.then(
      () => didWriteSavedThemes.fire(),
      () => {}
    );
  }

  return result;
}

export function createSavedThemeId(): string {
  return crypto.randomUUID();
}

export function isSavedThemeId(candidate: string): boolean {
  return SAVED_THEME_ID_PATTERN.test(candidate);
}

/** A UUID for this VS Code profile, created the first time it is asked for. Deliberately not synced. */
export async function getSyncMachineId(context: vscode.ExtensionContext): Promise<string> {
  const storedMachineId = context.globalState.get<string>(SYNC_MACHINE_ID_STATE_KEY);
  if (storedMachineId) {
    return storedMachineId;
  }

  const machineId = crypto.randomUUID();
  await context.globalState.update(SYNC_MACHINE_ID_STATE_KEY, machineId);

  return machineId;
}

// ---------------------------------------------------------------------------------------------
// Reads

/** Newest first. Tombstones are left out, and so is a file that cannot be parsed. */
export async function listSavedThemes(context: vscode.ExtensionContext): Promise<SavedThemeSummary[]> {
  const index = await readThemeIndex(context);

  return listSavedThemesInIndex(context, index);
}

export async function readSavedTheme(context: vscode.ExtensionContext, savedThemeId: string): Promise<ColorThemeDocument> {
  const contents = await vscode.workspace.fs.readFile(getSavedThemeUri(context, savedThemeId));
  return JSON.parse(new TextDecoder().decode(contents)) as ColorThemeDocument;
}

export async function getTakenFromSources(
  context: vscode.ExtensionContext,
  savedThemeId: string
): Promise<Record<string, TakenFromSource>> {
  const index = await readThemeIndex(context);

  return index.themes[savedThemeId]?.takenFromSources ?? {};
}

/** Missing file → an empty index. A newer version is returned as is; writes refuse it. */
export async function readThemeIndex(context: vscode.ExtensionContext): Promise<ThemeIndex> {
  let contents: Uint8Array;

  try {
    contents = await vscode.workspace.fs.readFile(getThemeIndexUri(context));
  } catch (error) {
    const isFileMissing = error instanceof vscode.FileSystemError && error.code === "FileNotFound";
    if (isFileMissing) {
      return createEmptyThemeIndex();
    }

    throw new Error(`themes/index.json is unreadable: ${getErrorMessage(error)}`, { cause: error });
  }

  try {
    return JSON.parse(new TextDecoder().decode(contents)) as ThemeIndex;
  } catch (error) {
    throw new Error(`themes/index.json is unreadable: ${getErrorMessage(error)}`, { cause: error });
  }
}

export function getActiveSavedThemeId(context: vscode.ExtensionContext, base: ThemeBaseKind): string | undefined {
  return getActiveSavedThemeIds(context)[base];
}

export async function setActiveSavedThemeId(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  savedThemeId: string | undefined
): Promise<void> {
  const activeSavedThemeIds: ActiveSavedThemeIds = { ...getActiveSavedThemeIds(context), [base]: savedThemeId };
  await context.globalState.update(ACTIVE_SAVED_THEME_IDS_STATE_KEY, activeSavedThemeIds);
}

// ---------------------------------------------------------------------------------------------
// Writes

/** The document and its provenance land together. The entry's revision vector is bumped for this machine. */
export function writeSavedTheme(
  context: vscode.ExtensionContext,
  savedThemeId: string,
  theme: ColorThemeDocument,
  takenFromSources: Record<string, TakenFromSource>
): Promise<void> {
  return runStorageOperation(() => writeSavedThemeFileAndEntry(context, savedThemeId, theme, takenFromSources));
}

export function renameSavedTheme(context: vscode.ExtensionContext, savedThemeId: string, newName: string): Promise<void> {
  return runStorageOperation(async () => {
    const theme = await readSavedTheme(context, savedThemeId);
    theme.name = newName;

    const takenFromSources = await getTakenFromSources(context, savedThemeId);
    await writeSavedThemeFileAndEntry(context, savedThemeId, theme, takenFromSources);
  });
}

/** @param newName Defaults to the original name followed by " copy". */
export function duplicateSavedTheme(context: vscode.ExtensionContext, savedThemeId: string, newName?: string): Promise<string> {
  return runStorageOperation(async () => {
    const theme = await readSavedTheme(context, savedThemeId);
    theme.name = newName ?? `${theme.name} copy`;

    const takenFromSources = await getTakenFromSources(context, savedThemeId);
    const duplicateThemeId = createSavedThemeId();
    await writeSavedThemeFileAndEntry(context, duplicateThemeId, theme, takenFromSources);

    return duplicateThemeId;
  });
}

/**
 * Leaves a tombstone behind. Provenance is kept, because a resurrected theme keeps its labels. Where the theme was active, the
 * newest other theme of that base takes its place. Returns that replacement per base, null when none is left.
 */
export function deleteSavedTheme(context: vscode.ExtensionContext, savedThemeId: string): Promise<ReplacementThemeByBase> {
  return runStorageOperation(async () => {
    const index = await readWritableThemeIndex(context);
    const machineId = await getSyncMachineId(context);
    const existingEntry = index.themes[savedThemeId];
    const now = new Date().toISOString();

    index.themes[savedThemeId] = {
      revisions: bumpRevisionVector(existingEntry?.revisions ?? {}, machineId),
      updatedAt: existingEntry?.updatedAt ?? now,
      deletedAt: now,
      takenFromSources: existingEntry?.takenFromSources ?? {},
    };

    const replacementThemeByBase = await removeSavedThemeFileAndReplaceWhereActive(context, savedThemeId, index);
    await writeThemeIndex(context, index);

    return replacementThemeByBase;
  });
}

/**
 * A pull that deletes the theme being edited keeps its file until the edits are settled. This finishes that delete. Undefined
 * when the theme is not a tombstone.
 */
export function finishDeferredSavedThemeDelete(
  context: vscode.ExtensionContext,
  savedThemeId: string
): Promise<ReplacementThemeByBase | undefined> {
  return runStorageOperation(
    async () => {
      const index = await readThemeIndex(context);

      const entry = index.themes[savedThemeId];
      if (!entry || !isTombstone(entry)) {
        return;
      }

      return removeSavedThemeFileAndReplaceWhereActive(context, savedThemeId, index);
    },
    { isSilent: true }
  );
}

/**
 * Writes exactly what the plan says, files first and the index last. Runs inside `runStorageOperation`, the caller holds the
 * chain. Files of the ids in `keptFileIds` stay on disk even when the plan deletes them, and their active bases are not moved.
 */
export async function applySyncPlan(
  context: vscode.ExtensionContext,
  plan: SyncPlan,
  keptFileIds: ReadonlySet<string>
): Promise<ReplacementThemeByBase> {
  await createSavedThemesDirectoryIfMissing(context);

  for (const themeWrite of [...plan.writeLocal, ...plan.conflictCopies]) {
    await writeSavedThemeFile(context, themeWrite.id, themeWrite.document);
  }

  const replacementThemeByBase: ReplacementThemeByBase = new Map();

  for (const themeDelete of plan.deleteLocal) {
    if (keptFileIds.has(themeDelete.id)) continue;

    const replacements = await removeSavedThemeFileAndReplaceWhereActive(context, themeDelete.id, plan.nextLocalIndex);

    for (const [base, replacement] of replacements) {
      replacementThemeByBase.set(base, replacement);
    }
  }

  await writeThemeIndex(context, plan.nextLocalIndex);

  return replacementThemeByBase;
}

// ---------------------------------------------------------------------------------------------
// Activate

/** Call on every activate. An extension update extracts into a fresh directory and puts the shipped placeholder back. */
export async function restoreGeneratedThemeFiles(context: vscode.ExtensionContext): Promise<GeneratedThemeRestoreFailure[]> {
  const restoreFailures: GeneratedThemeRestoreFailure[] = [];

  try {
    await runStorageOperation(() => migrateThemeIndex(context), { isSilent: true });
  } catch (error) {
    restoreFailures.push({ reason: "theme-index-not-migrated", message: getErrorMessage(error) });
  }

  for (const base of THEME_BASE_KINDS) {
    const activeSavedThemeId = getActiveSavedThemeId(context, base);
    if (!activeSavedThemeId) continue;

    let theme: ColorThemeDocument;

    try {
      theme = await readSavedTheme(context, activeSavedThemeId);
    } catch (error) {
      restoreFailures.push({ base, reason: "saved-theme-unreadable", message: getErrorMessage(error) });
      continue;
    }

    try {
      await writeGeneratedTheme(context, base, theme);
    } catch (error) {
      restoreFailures.push({ base, ...classifyGeneratedThemeWriteError(error) });
    }
  }

  return restoreFailures;
}

// Brings the index in line with the files. Runs before anything else touches storage.
async function migrateThemeIndex(context: vscode.ExtensionContext): Promise<void> {
  const index = await readWritableThemeIndex(context);
  const machineId = await getSyncMachineId(context);
  const legacyTakenFromSources = context.globalState.get<LegacyTakenFromSourcesBySavedThemeId>(LEGACY_TAKEN_FROM_STATE_KEY);

  const savedThemeIdsOnDisk = await listSavedThemeIdsOnDisk(context);
  let hasChanged = false;

  for (const savedThemeId of savedThemeIdsOnDisk) {
    if (Object.hasOwn(index.themes, savedThemeId)) continue;

    const fileStat = await vscode.workspace.fs.stat(getSavedThemeUri(context, savedThemeId));

    index.themes[savedThemeId] = {
      revisions: bumpRevisionVector({}, machineId),
      updatedAt: new Date(fileStat.mtime).toISOString(),
      takenFromSources: legacyTakenFromSources?.[savedThemeId] ?? {},
    };

    hasChanged = true;
  }

  for (const [savedThemeId, entry] of Object.entries(index.themes)) {
    const hasFile = savedThemeIdsOnDisk.has(savedThemeId);

    // A file can go missing through a crash or a hand-edit. A tombstone would push that loss to every other machine as
    // a deliberate delete. Dropping the entry makes the theme "only remote" on the next sync, and it comes back.
    if (!isTombstone(entry) && !hasFile) {
      delete index.themes[savedThemeId];
      hasChanged = true;
      continue;
    }

    // A pull deleted the theme being edited, and a restart took the working copy with it.
    if (isTombstone(entry) && hasFile) {
      const replacements = await removeSavedThemeFileAndReplaceWhereActive(context, savedThemeId, index);

      for (const [base, replacement] of replacements) {
        if (replacement === null) {
          await writeGeneratedTheme(context, base, createEmptyTheme(base));
        }
      }
    }
  }

  if (hasChanged) {
    await writeThemeIndex(context, index);
  }

  if (legacyTakenFromSources !== undefined) {
    await context.globalState.update(LEGACY_TAKEN_FROM_STATE_KEY, undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Inside the chain

async function writeSavedThemeFileAndEntry(
  context: vscode.ExtensionContext,
  savedThemeId: string,
  theme: ColorThemeDocument,
  takenFromSources: Record<string, TakenFromSource>
): Promise<void> {
  const index = await readWritableThemeIndex(context);
  const machineId = await getSyncMachineId(context);

  await createSavedThemesDirectoryIfMissing(context);
  await writeSavedThemeFile(context, savedThemeId, theme);

  const existingEntry = index.themes[savedThemeId];

  index.themes[savedThemeId] = {
    revisions: bumpRevisionVector(existingEntry?.revisions ?? {}, machineId),
    updatedAt: new Date().toISOString(),
    takenFromSources,
  };

  await writeThemeIndex(context, index);
}

// The active id moves before the file goes, so nothing can read the file of the active theme and find it missing.
async function removeSavedThemeFileAndReplaceWhereActive(
  context: vscode.ExtensionContext,
  savedThemeId: string,
  index: ThemeIndex
): Promise<ReplacementThemeByBase> {
  const replacementThemeByBase: ReplacementThemeByBase = new Map();

  for (const base of THEME_BASE_KINDS) {
    if (getActiveSavedThemeId(context, base) !== savedThemeId) continue;

    const savedThemesInIndex = await listSavedThemesInIndex(context, index);
    const replacementSummary = savedThemesInIndex.find(summary => summary.base === base && summary.id !== savedThemeId);

    await setActiveSavedThemeId(context, base, replacementSummary?.id);

    const replacementTheme = replacementSummary ? await readSavedTheme(context, replacementSummary.id) : null;
    replacementThemeByBase.set(base, replacementTheme);
  }

  await deleteSavedThemeFileIfPresent(context, savedThemeId);

  return replacementThemeByBase;
}

async function readWritableThemeIndex(context: vscode.ExtensionContext): Promise<ThemeIndex> {
  const index = await readThemeIndex(context);

  if (index.version > THEME_INDEX_VERSION) {
    throw new Error("themes/index.json was written by a newer Theme Editor");
  }

  return index;
}

async function writeThemeIndex(context: vscode.ExtensionContext, index: ThemeIndex): Promise<void> {
  await createSavedThemesDirectoryIfMissing(context);

  const contents = new TextEncoder().encode(JSON.stringify(index, null, 2));
  await vscode.workspace.fs.writeFile(getThemeIndexUri(context), contents);
}

async function writeSavedThemeFile(
  context: vscode.ExtensionContext,
  savedThemeId: string,
  theme: ColorThemeDocument
): Promise<void> {
  const contents = new TextEncoder().encode(JSON.stringify(theme, null, 2));
  await vscode.workspace.fs.writeFile(getSavedThemeUri(context, savedThemeId), contents);
}

async function deleteSavedThemeFileIfPresent(context: vscode.ExtensionContext, savedThemeId: string): Promise<void> {
  try {
    await vscode.workspace.fs.delete(getSavedThemeUri(context, savedThemeId));
  } catch (error) {
    const isFileAlreadyGone = error instanceof vscode.FileSystemError && error.code === "FileNotFound";
    if (!isFileAlreadyGone) {
      throw error;
    }
  }
}

async function listSavedThemesInIndex(context: vscode.ExtensionContext, index: ThemeIndex): Promise<SavedThemeSummary[]> {
  const liveEntries = Object.entries(index.themes).filter(([, entry]) => !isTombstone(entry));

  const savedThemeSummaries = await Promise.all(
    liveEntries.map(([savedThemeId, entry]) => readSavedThemeSummary(context, savedThemeId, entry))
  );

  const readableSavedThemeSummaries = savedThemeSummaries.filter(savedThemeSummary => savedThemeSummary !== undefined);

  return readableSavedThemeSummaries.toSorted((left, right) => right.lastModifiedAt - left.lastModifiedAt);
}

async function readSavedThemeSummary(
  context: vscode.ExtensionContext,
  savedThemeId: string,
  entry: ThemeIndexEntry
): Promise<SavedThemeSummary | undefined> {
  try {
    const theme = await readSavedTheme(context, savedThemeId);

    return { id: savedThemeId, name: theme.name, base: theme.type, lastModifiedAt: Date.parse(entry.updatedAt) };
  } catch {
    return undefined;
  }
}

async function listSavedThemeIdsOnDisk(context: vscode.ExtensionContext): Promise<Set<string>> {
  await createSavedThemesDirectoryIfMissing(context);

  const directoryEntries = await vscode.workspace.fs.readDirectory(getSavedThemesDirectoryUri(context));

  const savedThemeIds = directoryEntries
    .filter(([entryName, entryType]) => entryType === vscode.FileType.File && entryName.endsWith(".json"))
    .map(([entryName]) => entryName.slice(0, -".json".length))
    .filter(savedThemeId => isSavedThemeId(savedThemeId));

  return new Set(savedThemeIds);
}

function getSavedThemesDirectoryUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, SAVED_THEMES_DIRECTORY_NAME);
}

function getThemeIndexUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(getSavedThemesDirectoryUri(context), THEME_INDEX_FILE_NAME);
}

function getSavedThemeUri(context: vscode.ExtensionContext, savedThemeId: string): vscode.Uri {
  // Uri.joinPath resolves "..". An id that is not a plain UUID could point outside global storage.
  if (!isSavedThemeId(savedThemeId)) {
    throw new Error(`Not a saved theme id: ${savedThemeId}`);
  }

  return vscode.Uri.joinPath(getSavedThemesDirectoryUri(context), `${savedThemeId}.json`);
}

async function createSavedThemesDirectoryIfMissing(context: vscode.ExtensionContext): Promise<void> {
  await vscode.workspace.fs.createDirectory(getSavedThemesDirectoryUri(context));
}

function getActiveSavedThemeIds(context: vscode.ExtensionContext): ActiveSavedThemeIds {
  return context.globalState.get<ActiveSavedThemeIds>(ACTIVE_SAVED_THEME_IDS_STATE_KEY, {});
}
