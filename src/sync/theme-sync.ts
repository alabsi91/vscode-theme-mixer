import * as vscode from "vscode";

import { applyThemeDocument } from "../theme/apply-theme.ts";
import {
  THEME_BASE_KINDS,
  applySyncPlan,
  createSavedThemeId,
  getActiveSavedThemeId,
  getSyncMachineId,
  isSavedThemeId,
  onDidWriteSavedThemes,
  readSavedTheme,
  readThemeIndex,
  runStorageOperation,
} from "../theme/theme-storage.ts";
import { getWorkingTheme, recordApplyResult, showReplacementThemes } from "../theme/working-theme.ts";
import { createGist, deleteGist, findGistByDescription, readGist, readRawFile, updateGist } from "./github-gist-client.ts";
import {
  THEME_INDEX_VERSION,
  UnsupportedIndexVersionError,
  bumpRevisionVector,
  createEmptyThemeIndex,
  createSyncPlan,
  willSyncPlanChangeGist,
} from "./theme-sync-merge.ts";

import type { SyncState } from "../panel/webview-protocol.ts";
import type { ColorThemeDocument } from "../theme/generated-theme-file.ts";
import type { ReplacementThemeByBase, ThemeIndex, ThemeIndexEntry } from "../theme/theme-storage.ts";
import type { GistFileChanges, GistSnapshot, RateLimit } from "./github-gist-client.ts";
import type { SyncPlan } from "./theme-sync-merge.ts";

/** The only key that rides Settings Sync. */
const SYNC_GIST_ID_STATE_KEY = "syncGistId";

/** Per machine. Stopping on the laptop does not stop the desktop. */
const SYNC_ENABLED_STATE_KEY = "syncEnabled";

const SYNC_LAST_SYNCED_AT_STATE_KEY = "syncLastSyncedAt";

const GIST_DESCRIPTION = "vscode-theme-editor:themes";

const GITHUB_AUTHENTICATION_PROVIDER_ID = "github";

const GIST_SCOPES = ["gist"];

const INDEX_FILE_NAME = "index.json";

/** The gist file list is truncated past 300 files. */
const MAXIMUM_SYNCED_THEMES = 290;

/** Past this the API cannot return a file at all. */
const MAXIMUM_GIST_FILE_BYTES = 10 * 1024 * 1024;

const WRITE_COALESCE_MILLISECONDS = 2000;

const ENABLE_SYNC_MESSAGE =
  'Theme Editor will create a secret gist named "vscode-theme-editor:themes" on your GitHub account and keep your saved ' +
  "themes in it as JSON files.";

const ENABLE_SYNC_DETAIL =
  "Secret gists are not listed on your profile, but anyone who has the link can read them. Nothing else on your account " +
  "is read or changed.\n\nTurning sync off later only affects this machine. The gist stays unless you choose to delete it.";

interface RemoteGistFile {
  rawUrl?: string;
  size: number;
  content?: string;
}

interface RemoteGistCache {
  etag?: string;
  updatedAt: string;
  /** As the gist's index.json has it. Orphan files are not in here. */
  index: ThemeIndex;
  /** Keyed by file name. */
  files: Record<string, RemoteGistFile>;
}

type SyncOutcome =
  | { status: "on"; message?: string }
  | { status: "paused"; message: string; resumeAt?: number }
  | { status: "error"; message: string };

type SyncFailure = { ok: false; outcome: SyncOutcome };

interface AppliedSyncPlan {
  plan: SyncPlan;
  replacementThemeByBase: ReplacementThemeByBase;
}

const didChangeSyncState = new vscode.EventEmitter<SyncState>();

export const onDidChangeSyncState: vscode.Event<SyncState> = didChangeSyncState.event;

let syncState: SyncState = { status: "off" };

let accountLabel: string | undefined;

let remoteCache: RemoteGistCache | undefined;

let isRunInFlight = false;

let shouldRunAgain = false;

let hasSeenUnauthorized = false;

let coalesceTimer: ReturnType<typeof setTimeout> | undefined;

let rateLimitTimer: ReturnType<typeof setTimeout> | undefined;

export function getSyncState(): SyncState {
  return syncState;
}

export function isSyncEnabled(context: vscode.ExtensionContext): boolean {
  return context.globalState.get<boolean>(SYNC_ENABLED_STATE_KEY, false);
}

/** Call once from activate, after the generated theme files are restored. Fires the activate-time run. */
export function startThemeSync(context: vscode.ExtensionContext): vscode.Disposable {
  context.globalState.setKeysForSync([SYNC_GIST_ID_STATE_KEY]);

  syncState = {
    status: isSyncEnabled(context) ? "syncing" : "off",
    lastSyncedAt: context.globalState.get<string>(SYNC_LAST_SYNCED_AT_STATE_KEY),
  };

  const subscriptions = [
    onDidWriteSavedThemes(() => {
      if (!isSyncEnabled(context)) return;

      clearTimeout(coalesceTimer);
      coalesceTimer = setTimeout(() => void requestSync(context), WRITE_COALESCE_MILLISECONDS);
    }),

    // Signing in from the Accounts menu resumes without a button press.
    vscode.authentication.onDidChangeSessions(event => {
      if (event.provider.id === GITHUB_AUTHENTICATION_PROVIDER_ID) {
        void requestSync(context);
      }
    }),
  ];

  void requestSync(context);

  return new vscode.Disposable(() => {
    clearTimeout(coalesceTimer);
    clearTimeout(rateLimitTimer);

    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  });
}

/** One run at a time. A request during a run queues exactly one more. */
export async function requestSync(context: vscode.ExtensionContext): Promise<void> {
  if (!isSyncEnabled(context)) return;

  if (isRunInFlight) {
    shouldRunAgain = true;
    return;
  }

  isRunInFlight = true;

  try {
    do {
      shouldRunAgain = false;
      setSyncState({ status: "syncing", accountLabel, lastSyncedAt: syncState.lastSyncedAt });

      const outcome = await runSync(context);

      if (isSyncEnabled(context)) {
        await recordSyncOutcome(context, outcome);
      }
    } while (shouldRunAgain && isSyncEnabled(context));
  } finally {
    isRunInFlight = false;
  }
}

export async function enableSync(context: vscode.ExtensionContext): Promise<void> {
  if (!isSyncEnabled(context)) {
    const turnOnAction = "Turn on";

    const chosenAction = await vscode.window.showInformationMessage(
      ENABLE_SYNC_MESSAGE,
      { modal: true, detail: ENABLE_SYNC_DETAIL },
      turnOnAction
    );

    if (chosenAction !== turnOnAction) return;
  }

  const session = await getSessionInteractively();
  if (!session) return;

  hasSeenUnauthorized = false;
  accountLabel = session.account.label;

  await context.globalState.update(SYNC_ENABLED_STATE_KEY, true);
  setSyncState({ status: "syncing", accountLabel, lastSyncedAt: syncState.lastSyncedAt });

  await requestSync(context);
}

export async function disableSync(context: vscode.ExtensionContext): Promise<void> {
  const stopAction = "Stop";
  const stopAndDeleteAction = "Stop and delete the gist";

  const chosenAction = await vscode.window.showWarningMessage(
    "Stop syncing on this machine?",
    { modal: true, detail: `${stopAndDeleteAction}: other machines will start a new gist from their own copies.` },
    stopAction,
    stopAndDeleteAction
  );

  if (chosenAction === undefined) return;

  await context.globalState.update(SYNC_ENABLED_STATE_KEY, false);

  clearTimeout(coalesceTimer);
  clearTimeout(rateLimitTimer);
  shouldRunAgain = false;
  remoteCache = undefined;

  setSyncState({ status: "off" });

  if (chosenAction !== stopAndDeleteAction) return;

  const gistId = context.globalState.get<string>(SYNC_GIST_ID_STATE_KEY);
  const session = await getSessionSilently();

  if (gistId && session) {
    const result = await deleteGist(session.accessToken, gistId);

    if (!result.ok) {
      void vscode.window.showWarningMessage(`Theme Editor: the gist was not deleted. ${result.message}`);
    }
  } else if (gistId) {
    void vscode.window.showWarningMessage("Theme Editor: not signed in to GitHub, so the gist was not deleted.");
  }

  await context.globalState.update(SYNC_GIST_ID_STATE_KEY, undefined);
}

// ---------------------------------------------------------------------------------------------
// One run

async function runSync(context: vscode.ExtensionContext): Promise<SyncOutcome> {
  const themeCountCheck = await checkSyncedThemeCount(context);
  if (themeCountCheck) {
    return themeCountCheck;
  }

  const session = await getSessionSilently();
  if (!session) {
    return { status: "paused", message: "Sign in to GitHub to sync." };
  }

  accountLabel = session.account.label;
  const token = session.accessToken;

  const gistRead = await readRemoteGist(context, token);
  if (!gistRead.ok) {
    return gistRead.outcome;
  }

  const { gistId } = gistRead;
  const machineId = await getSyncMachineId(context);

  // The check-then-PATCH window is one round-trip wide. Losing it once means merging again against what landed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const cache = remoteCache;
    if (!cache) {
      return { status: "error", message: "Could not reach GitHub: the gist was not read" };
    }

    const applied = await mergeAndApply(context, token, cache, machineId);
    if (!applied.ok) {
      return applied.outcome;
    }

    await showPulledThemes(context, applied.plan, applied.replacementThemeByBase);

    const skippedMessage = getSkippedMessage(applied.plan);

    if (!willSyncPlanChangeGist(applied.plan, cache.index)) {
      return { status: "on", message: skippedMessage };
    }

    const check = await readGist(token, gistId, cache.etag);
    if (!check.ok) {
      return getOutcomeForFailure(check);
    }

    if (check.value.notModified) {
      const pushed = await pushSyncPlan(token, gistId, cache, applied.plan);
      if (!pushed.ok) {
        return pushed.outcome;
      }

      return { status: "on", message: skippedMessage };
    }

    const rebuilt = await buildRemoteCache(token, check.value.gist);
    if (!rebuilt.ok) {
      return rebuilt.outcome;
    }

    remoteCache = rebuilt.cache;
  }

  return { status: "error", message: "Another machine is syncing right now. Try again in a moment." };
}

async function checkSyncedThemeCount(context: vscode.ExtensionContext): Promise<SyncOutcome | undefined> {
  let localIndex: ThemeIndex;

  try {
    localIndex = await readThemeIndex(context);
  } catch (error) {
    return { status: "error", message: getErrorMessage(error) };
  }

  if (localIndex.version > THEME_INDEX_VERSION) {
    return { status: "error", message: "themes/index.json was written by a newer Theme Editor" };
  }

  if (Object.keys(localIndex.themes).length > MAXIMUM_SYNCED_THEMES) {
    return {
      status: "paused",
      message: `More than ${MAXIMUM_SYNCED_THEMES} themes cannot sync. Delete some or turn sync off.`,
    };
  }

  return undefined;
}

type MergeAndApplyResult = ({ ok: true } & AppliedSyncPlan) | SyncFailure;

// Holds the storage chain from the local read to the index write, so no Save can land in between and be overwritten.
async function mergeAndApply(
  context: vscode.ExtensionContext,
  token: string,
  cache: RemoteGistCache,
  machineId: string
): Promise<MergeAndApplyResult> {
  const mergeAndApplyInsideChain = async (): Promise<MergeAndApplyResult> => {
    const localIndex = await readThemeIndex(context);

    const plan = await createSyncPlan({
      local: localIndex,
      remote: getRemoteIndexWithOrphans(cache, machineId),
      machineId,
      readLocalDocument: savedThemeId => readLocalDocument(context, savedThemeId),
      readRemoteDocument: savedThemeId => readRemoteDocument(token, cache, savedThemeId),
      now: new Date().toISOString(),
      createId: createSavedThemeId,
    });

    const workingCopyIds = new Set(
      THEME_BASE_KINDS.map(base => getWorkingTheme(base)?.savedThemeId).filter(id => id !== undefined)
    );
    const replacementThemeByBase = await applySyncPlan(context, plan, workingCopyIds);

    flagWorkingCopiesUnderneathPulls(plan);

    return { ok: true, plan, replacementThemeByBase };
  };

  try {
    return await runStorageOperation(mergeAndApplyInsideChain, { isSilent: true });
  } catch (error) {
    if (error instanceof UnsupportedIndexVersionError) {
      const message = "Update Theme Editor to keep syncing. The gist was written by a newer version.";
      return { ok: false, outcome: { status: "paused", message } };
    }

    return { ok: false, outcome: { status: "error", message: getErrorMessage(error) } };
  }
}

async function readLocalDocument(
  context: vscode.ExtensionContext,
  savedThemeId: string
): Promise<ColorThemeDocument | undefined> {
  try {
    return await readSavedTheme(context, savedThemeId);
  } catch {
    return;
  }
}

// The working copy is never touched. Save reads the flag and asks.
function flagWorkingCopiesUnderneathPulls(plan: SyncPlan): void {
  const pulledIds = new Set([...plan.writeLocal.map(write => write.id), ...plan.deleteLocal.map(themeDelete => themeDelete.id)]);

  for (const base of THEME_BASE_KINDS) {
    const workingTheme = getWorkingTheme(base);

    if (workingTheme && pulledIds.has(workingTheme.savedThemeId)) {
      workingTheme.hasRemoteChangesUnderneath = true;
    }
  }
}

async function showPulledThemes(
  context: vscode.ExtensionContext,
  plan: SyncPlan,
  replacementThemeByBase: ReplacementThemeByBase
): Promise<void> {
  for (const base of THEME_BASE_KINDS) {
    if (getWorkingTheme(base) || replacementThemeByBase.has(base)) continue;

    const activeSavedThemeId = getActiveSavedThemeId(context, base);
    const pulledWrite = plan.writeLocal.find(write => write.id === activeSavedThemeId);

    if (pulledWrite) {
      recordApplyResult(await applyThemeDocument(context, base, pulledWrite.document));
    }
  }

  await showReplacementThemes(context, replacementThemeByBase);
}

function getSkippedMessage(plan: SyncPlan): string | undefined {
  if (plan.skipped.length === 0) {
    return undefined;
  }

  const skippedNames = plan.skipped.map(skipped => skipped.name ?? skipped.id).join(", ");

  return `Skipped: ${skippedNames}, could not be read from the gist`;
}

async function recordSyncOutcome(context: vscode.ExtensionContext, outcome: SyncOutcome): Promise<void> {
  if (outcome.status === "on") {
    const lastSyncedAt = new Date().toISOString();
    await context.globalState.update(SYNC_LAST_SYNCED_AT_STATE_KEY, lastSyncedAt);

    setSyncState({ status: "on", accountLabel, lastSyncedAt, message: outcome.message });
    return;
  }

  setSyncState({ status: outcome.status, accountLabel, lastSyncedAt: syncState.lastSyncedAt, message: outcome.message });

  if (outcome.status === "paused" && outcome.resumeAt !== undefined) {
    clearTimeout(rateLimitTimer);
    rateLimitTimer = setTimeout(() => void requestSync(context), Math.max(outcome.resumeAt - Date.now(), 0) + 1000);
  }
}

function setSyncState(nextSyncState: SyncState): void {
  syncState = nextSyncState;
  didChangeSyncState.fire(syncState);
}

// ---------------------------------------------------------------------------------------------
// Sessions

async function getSessionSilently(): Promise<vscode.AuthenticationSession | undefined> {
  try {
    return await vscode.authentication.getSession(GITHUB_AUTHENTICATION_PROVIDER_ID, GIST_SCOPES, { silent: true });
  } catch {
    return undefined;
  }
}

// Undefined when the user backed out of the consent dialog.
async function getSessionInteractively(): Promise<vscode.AuthenticationSession | undefined> {
  try {
    if (hasSeenUnauthorized) {
      return await vscode.authentication.getSession(GITHUB_AUTHENTICATION_PROVIDER_ID, GIST_SCOPES, { forceNewSession: true });
    }

    return await vscode.authentication.getSession(GITHUB_AUTHENTICATION_PROVIDER_ID, GIST_SCOPES, { createIfNone: true });
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// The gist

// Finds or creates the gist, reads it, and fills the cache. One 404 is forgiven, the id gets resolved again.
async function readRemoteGist(
  context: vscode.ExtensionContext,
  token: string
): Promise<SyncFailure | { ok: true; gistId: string }> {
  let gistIdResult = await resolveGistId(context, token);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!gistIdResult.ok) {
      return { ok: false, outcome: gistIdResult.outcome };
    }

    const { gistId } = gistIdResult;
    const read = await readGist(token, gistId, remoteCache?.etag);

    if (read.ok) {
      if (read.value.notModified && remoteCache) {
        return { ok: true, gistId };
      }

      if (read.value.notModified) {
        return { ok: false, outcome: { status: "error", message: "Could not reach GitHub: unexpected 304" } };
      }

      const built = await buildRemoteCache(token, read.value.gist);
      if (!built.ok) {
        return built;
      }

      remoteCache = built.cache;
      return { ok: true, gistId };
    }

    if (read.status !== 404) {
      return { ok: false, outcome: getOutcomeForFailure(read) };
    }

    await context.globalState.update(SYNC_GIST_ID_STATE_KEY, undefined);
    remoteCache = undefined;
    gistIdResult = await resolveGistId(context, token);
  }

  return {
    ok: false,
    outcome: { status: "error", message: "The sync gist is gone. Turn sync off and on to create a new one." },
  };
}

// The stored id, else the oldest gist with our description, else a fresh one.
async function resolveGistId(
  context: vscode.ExtensionContext,
  token: string
): Promise<SyncFailure | { ok: true; gistId: string }> {
  const storedGistId = context.globalState.get<string>(SYNC_GIST_ID_STATE_KEY);
  if (storedGistId) {
    return { ok: true, gistId: storedGistId };
  }

  const found = await findGistByDescription(token, GIST_DESCRIPTION);
  if (!found.ok) {
    return { ok: false, outcome: getOutcomeForFailure(found) };
  }

  if (found.value) {
    await context.globalState.update(SYNC_GIST_ID_STATE_KEY, found.value);
    return { ok: true, gistId: found.value };
  }

  const emptyIndexContent = JSON.stringify(createEmptyThemeIndex(), null, 2);
  const created = await createGist(token, GIST_DESCRIPTION, { [INDEX_FILE_NAME]: { content: emptyIndexContent } });
  if (!created.ok) {
    return { ok: false, outcome: getOutcomeForFailure(created) };
  }

  await context.globalState.update(SYNC_GIST_ID_STATE_KEY, created.value);
  return { ok: true, gistId: created.value };
}

async function buildRemoteCache(token: string, gist: GistSnapshot): Promise<SyncFailure | { ok: true; cache: RemoteGistCache }> {
  const files: Record<string, RemoteGistFile> = {};

  for (const [fileName, file] of Object.entries(gist.files)) {
    if (fileName !== INDEX_FILE_NAME && !isSavedThemeFileName(fileName)) continue;

    files[fileName] = { rawUrl: file.rawUrl, size: file.size, content: file.truncated ? undefined : file.content };
  }

  const cache: RemoteGistCache = { etag: gist.etag, updatedAt: gist.updatedAt, index: createEmptyThemeIndex(), files };

  // A gist without an index is treated as empty. Its theme files are adopted as orphans.
  if (!Object.hasOwn(files, INDEX_FILE_NAME)) {
    return { ok: true, cache };
  }

  const indexContent = await readRemoteFileContent(token, files, INDEX_FILE_NAME);
  if (indexContent === undefined) {
    return { ok: false, outcome: { status: "error", message: "Could not reach GitHub: index.json could not be read" } };
  }

  try {
    cache.index = sanitizeThemeIndex(JSON.parse(indexContent));
  } catch (error) {
    return {
      ok: false,
      outcome: { status: "error", message: `The gist's index.json is not valid JSON: ${getErrorMessage(error)}` },
    };
  }

  return { ok: true, cache };
}

// A stale index.json from another machine can drop an entry whose file is still there. The file must not stay invisible.
function getRemoteIndexWithOrphans(cache: RemoteGistCache, machineId: string): ThemeIndex {
  const index: ThemeIndex = { version: cache.index.version, themes: { ...cache.index.themes } };

  for (const fileName of Object.keys(cache.files)) {
    if (!isSavedThemeFileName(fileName)) continue;

    const savedThemeId = fileName.slice(0, -".json".length);
    if (Object.hasOwn(index.themes, savedThemeId)) continue;

    index.themes[savedThemeId] = {
      revisions: bumpRevisionVector({}, machineId),
      updatedAt: cache.updatedAt,
      takenFromSources: {},
    };
  }

  return index;
}

async function readRemoteDocument(
  token: string,
  cache: RemoteGistCache,
  savedThemeId: string
): Promise<ColorThemeDocument | undefined> {
  const fileName = `${savedThemeId}.json`;

  const file = cache.files[fileName];
  if (!file || file.size > MAXIMUM_GIST_FILE_BYTES) {
    return undefined;
  }

  const content = await readRemoteFileContent(token, cache.files, fileName);
  if (content === undefined) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    return isColorThemeDocument(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// The content of a truncated file is fetched once and kept.
async function readRemoteFileContent(
  token: string,
  files: Record<string, RemoteGistFile>,
  fileName: string
): Promise<string | undefined> {
  const file = files[fileName];
  if (!file) {
    return undefined;
  }

  if (file.content !== undefined) {
    return file.content;
  }

  if (file.rawUrl === undefined) {
    return undefined;
  }

  const raw = await readRawFile(token, file.rawUrl);
  if (!raw.ok) {
    return undefined;
  }

  file.content = raw.value;
  return raw.value;
}

async function pushSyncPlan(
  token: string,
  gistId: string,
  cache: RemoteGistCache,
  plan: SyncPlan
): Promise<SyncFailure | { ok: true }> {
  const fileChanges: GistFileChanges = { [INDEX_FILE_NAME]: { content: JSON.stringify(plan.nextRemoteIndex, null, 2) } };

  for (const write of [...plan.pushRemote, ...plan.conflictCopies]) {
    fileChanges[`${write.id}.json`] = { content: JSON.stringify(write.document, null, 2) };
  }

  for (const savedThemeId of plan.deleteRemote) {
    const fileName = `${savedThemeId}.json`;

    if (Object.hasOwn(cache.files, fileName)) {
      fileChanges[fileName] = null;
    }
  }

  const updated = await updateGist(token, gistId, fileChanges);
  if (!updated.ok) {
    return { ok: false, outcome: getOutcomeForFailure(updated) };
  }

  // The cache now says what the gist holds, so the next 304 is trustworthy.
  const files = { ...cache.files };

  for (const [fileName, change] of Object.entries(fileChanges)) {
    if (change === null) {
      delete files[fileName];
      continue;
    }

    files[fileName] = { rawUrl: files[fileName]?.rawUrl, size: change.content.length, content: change.content };
  }

  remoteCache = { etag: updated.value.etag, updatedAt: updated.value.updatedAt, index: plan.nextRemoteIndex, files };

  return { ok: true };
}

function getOutcomeForFailure(failure: { status: number; message: string; rateLimit?: RateLimit }): SyncOutcome {
  if (failure.status === 401) {
    hasSeenUnauthorized = true;
    return { status: "paused", message: "GitHub signed out. Sign in again to sync." };
  }

  if (failure.status === 403 && failure.rateLimit?.remaining === 0) {
    const resumeTime = new Date(failure.rateLimit.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return {
      status: "paused",
      message: `GitHub rate limit reached. Sync resumes at ${resumeTime}.`,
      resumeAt: failure.rateLimit.resetAt,
    };
  }

  return { status: "error", message: `Could not reach GitHub: ${failure.message}` };
}

// ---------------------------------------------------------------------------------------------
// What comes out of the gist is data from the network, not ours

function sanitizeThemeIndex(parsed: unknown): ThemeIndex {
  const index = createEmptyThemeIndex();
  if (!isRecord(parsed)) {
    return index;
  }

  if (typeof parsed.version === "number") {
    index.version = parsed.version;
  }

  if (!isRecord(parsed.themes)) {
    return index;
  }

  for (const [savedThemeId, entry] of Object.entries(parsed.themes)) {
    if (isSavedThemeId(savedThemeId) && isThemeIndexEntry(entry)) {
      index.themes[savedThemeId] = entry;
    }
  }

  return index;
}

function isThemeIndexEntry(value: unknown): value is ThemeIndexEntry {
  if (!isRecord(value) || !isRecord(value.revisions) || !isRecord(value.takenFromSources)) {
    return false;
  }

  const hasNumericRevisions = Object.values(value.revisions).every(count => typeof count === "number");
  const hasDeletedAt = value.deletedAt === undefined || typeof value.deletedAt === "string";

  return hasNumericRevisions && typeof value.updatedAt === "string" && hasDeletedAt;
}

function isColorThemeDocument(value: unknown): value is ColorThemeDocument {
  if (!isRecord(value)) {
    return false;
  }

  const hasBase = value.type === "dark" || value.type === "light";

  return typeof value.name === "string" && hasBase && isRecord(value.colors);
}

function isSavedThemeFileName(fileName: string): boolean {
  return fileName.endsWith(".json") && isSavedThemeId(fileName.slice(0, -".json".length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
