import * as vscode from "vscode";

import { applyThemeDocument } from "./apply-theme.ts";
import { composeAdjustedTheme } from "./compose-adjusted-theme.ts";
import { createEmptyTheme } from "./generated-theme-file.ts";
import {
  createSavedThemeId,
  finishDeferredSavedThemeDelete,
  getActiveSavedThemeId,
  getTakenFromSources,
  readSavedTheme,
  runStorageOperation,
  setActiveSavedThemeId,
  writeSavedTheme,
  writeSavedThemeFileAndEntry,
} from "./theme-storage.ts";

import type { ApplyThemeResult } from "./apply-theme.ts";
import type { ColorThemeDocument, ThemeBaseKind } from "./generated-theme-file.ts";
import type { ReplacementThemeByBase, TakenFromSource } from "./theme-storage.ts";

/** Edits paint the workbench straight away. Only Save touches storage. Discard puts the saved theme back. */
const EDITING_BASE_STATE_KEY = "editingBase";

export const DEFAULT_NEW_THEME_NAME = "My Theme";

export interface WorkingTheme {
  savedThemeId: string;
  theme: ColorThemeDocument;
  savedTheme: ColorThemeDocument;
  takenFromSources: Record<string, TakenFromSource>;
  /** Set by a sync pull that changed or deleted this theme underneath the edits. Save asks what to keep. */
  hasRemoteChangesUnderneath?: boolean;
}

const workingThemeByBase = new Map<ThemeBaseKind, WorkingTheme>();

let mostRecentApplyFailure: string | null = null;

export function getEditingBase(context: vscode.ExtensionContext): ThemeBaseKind {
  return context.globalState.get<ThemeBaseKind>(EDITING_BASE_STATE_KEY) ?? "dark";
}

export function setEditingBase(context: vscode.ExtensionContext, base: ThemeBaseKind): Thenable<void> {
  return context.globalState.update(EDITING_BASE_STATE_KEY, base);
}

export function hasUnsavedChanges(base: ThemeBaseKind): boolean {
  return workingThemeByBase.has(base);
}

export function getWorkingTheme(base: ThemeBaseKind): WorkingTheme | undefined {
  return workingThemeByBase.get(base);
}

export async function openEditableTheme(context: vscode.ExtensionContext, base: ThemeBaseKind): Promise<WorkingTheme> {
  const workingTheme = workingThemeByBase.get(base);
  const activeSavedThemeId = getActiveSavedThemeId(context, base);

  // An unsaved copy left behind by a theme that is no longer active would show its edits under the wrong name.
  if (workingTheme && workingTheme.savedThemeId === activeSavedThemeId) {
    return workingTheme;
  }

  workingThemeByBase.delete(base);

  const { savedThemeId, theme } = await openActiveSavedTheme(context, base);

  return {
    savedThemeId,
    theme,
    savedTheme: structuredClone(theme),
    takenFromSources: await getTakenFromSources(context, savedThemeId),
  };
}

/** The theme with the adjustment sliders baked in. What export and install hand out. */
export async function openExportableTheme(context: vscode.ExtensionContext, base: ThemeBaseKind): Promise<ColorThemeDocument> {
  const { theme } = await openEditableTheme(context, base);

  return composeAdjustedTheme(context, theme);
}

export async function beginEdit(context: vscode.ExtensionContext, base: ThemeBaseKind): Promise<WorkingTheme> {
  const editableTheme = await openEditableTheme(context, base);
  workingThemeByBase.set(base, editableTheme);

  return editableTheme;
}

/** False when the user backed out of the prompt about changes from another machine. */
export async function saveWorkingTheme(context: vscode.ExtensionContext, base: ThemeBaseKind): Promise<boolean> {
  // A pull sets the flag inside the chain. It has to be read there too.
  const workingThemeUnderRemoteChanges = await runStorageOperation(async () => {
    const workingTheme = workingThemeByBase.get(base);
    if (!workingTheme) return;

    if (workingTheme.hasRemoteChangesUnderneath) {
      return workingTheme;
    }

    await writeSavedThemeFileAndEntry(context, workingTheme.savedThemeId, workingTheme.theme, workingTheme.takenFromSources);
    workingThemeByBase.delete(base);
  });

  if (!workingThemeUnderRemoteChanges) {
    return true;
  }

  // The modal prompt waits outside the chain.
  return saveWorkingThemeOverRemoteChanges(context, base, workingThemeUnderRemoteChanges);
}

export async function discardWorkingTheme(context: vscode.ExtensionContext, base: ThemeBaseKind): Promise<void> {
  const workingTheme = workingThemeByBase.get(base);
  if (!workingTheme) return;

  workingThemeByBase.delete(base);

  // A pull that deleted this theme left its file alone while the edits were pending. Now they are gone.
  const replacementThemeByBase = await finishDeferredSavedThemeDelete(context, workingTheme.savedThemeId);

  if (replacementThemeByBase?.has(base)) {
    await showReplacementThemes(context, replacementThemeByBase);
    return;
  }

  const { theme } = await openActiveSavedTheme(context, base);
  recordApplyResult(await applyThemeDocument(context, base, theme));
}

/** Puts the saved values back for these keys only. Every other edit stays. */
export async function revertColors(context: vscode.ExtensionContext, base: ThemeBaseKind, colorIds: string[]): Promise<void> {
  const workingTheme = workingThemeByBase.get(base);
  if (!workingTheme) return;

  for (const colorId of colorIds) {
    const savedValue = workingTheme.savedTheme.colors[colorId];

    if (savedValue === undefined) {
      delete workingTheme.theme.colors[colorId];
    } else {
      workingTheme.theme.colors[colorId] = savedValue;
    }
  }

  recordApplyResult(await applyThemeDocument(context, base, workingTheme.theme));
}

/** Paints what took a deleted active theme's place. The shipped placeholder when nothing did. */
export async function showReplacementThemes(
  context: vscode.ExtensionContext,
  replacementThemeByBase: ReplacementThemeByBase
): Promise<void> {
  for (const [base, replacementTheme] of replacementThemeByBase) {
    recordApplyResult(await applyThemeDocument(context, base, replacementTheme ?? createEmptyTheme(base)));
  }
}

/** False when the user backed out. */
export async function settleUnsavedChanges(context: vscode.ExtensionContext, base: ThemeBaseKind): Promise<boolean> {
  if (!hasUnsavedChanges(base)) {
    return true;
  }

  const saveAction = "Save";
  const discardAction = "Discard";

  const chosenAction = await vscode.window.showWarningMessage(
    "You have unsaved theme changes.",
    { modal: true },
    saveAction,
    discardAction
  );

  if (chosenAction === saveAction) {
    return saveWorkingTheme(context, base);
  }

  if (chosenAction === discardAction) {
    await discardWorkingTheme(context, base);
    return true;
  }

  return false;
}

interface ActiveSavedTheme {
  savedThemeId: string;
  theme: ColorThemeDocument;
}

/** Creates one the first time, because every edit needs somewhere to land. */
export async function openActiveSavedTheme(context: vscode.ExtensionContext, base: ThemeBaseKind): Promise<ActiveSavedTheme> {
  const activeSavedTheme = await readActiveSavedTheme(context, base);
  if (activeSavedTheme) {
    return activeSavedTheme;
  }

  return runStorageOperation(() => createActiveSavedTheme(context, base));
}

/** `openActiveSavedTheme` for a caller inside `runStorageOperation`. The caller holds the chain. */
export async function openActiveSavedThemeInChain(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind
): Promise<ActiveSavedTheme> {
  const activeSavedTheme = await readActiveSavedTheme(context, base);
  if (activeSavedTheme) {
    return activeSavedTheme;
  }

  return createActiveSavedTheme(context, base);
}

async function readActiveSavedTheme(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind
): Promise<ActiveSavedTheme | undefined> {
  const activeSavedThemeId = getActiveSavedThemeId(context, base);
  if (!activeSavedThemeId) return;

  try {
    return { savedThemeId: activeSavedThemeId, theme: await readSavedTheme(context, activeSavedThemeId) };
  } catch (error) {
    // A missing or corrupt file starts fresh. Any other failure must not swap the theme for an empty one.
    if (!isMissingOrCorruptFile(error)) {
      throw error;
    }

    return;
  }
}

async function createActiveSavedTheme(context: vscode.ExtensionContext, base: ThemeBaseKind): Promise<ActiveSavedTheme> {
  const savedThemeId = createSavedThemeId();
  const theme = createEmptyTheme(base);
  theme.name = DEFAULT_NEW_THEME_NAME;

  await writeSavedThemeFileAndEntry(context, savedThemeId, theme, {});
  await setActiveSavedThemeId(context, base, savedThemeId);

  return { savedThemeId, theme };
}

function isMissingOrCorruptFile(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === "FileNotFound";
  }

  return error instanceof SyntaxError;
}

export function getMostRecentApplyFailure(): string | null {
  return mostRecentApplyFailure;
}

export function recordApplyResult(result: ApplyThemeResult): void {
  mostRecentApplyFailure = result.isApplied ? null : result.message;
}

export function recordApplyFailure(message: string): void {
  mostRecentApplyFailure = message;
}

async function saveWorkingThemeOverRemoteChanges(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  workingTheme: WorkingTheme
): Promise<boolean> {
  const keepMineAction = "Keep mine";
  const keepTheirsAction = "Keep theirs";
  const keepBothAction = "Keep both";

  const chosenAction = await vscode.window.showWarningMessage(
    "This theme changed on another machine while you were editing it.",
    { modal: true },
    keepMineAction,
    keepTheirsAction,
    keepBothAction
  );

  if (chosenAction === undefined) {
    return false;
  }

  if (chosenAction === keepTheirsAction) {
    await discardWorkingTheme(context, base);
    return true;
  }

  if (chosenAction === keepBothAction) {
    const ownCopyId = createSavedThemeId();
    const ownCopy: ColorThemeDocument = { ...workingTheme.theme, name: `${workingTheme.theme.name} (mine)` };

    await writeSavedTheme(context, ownCopyId, ownCopy, workingTheme.takenFromSources);
    await setActiveSavedThemeId(context, base, ownCopyId);
    workingThemeByBase.delete(base);

    // The pulled theme stays as it is. When the pull was a delete, its kept file goes now.
    await finishDeferredSavedThemeDelete(context, workingTheme.savedThemeId);

    recordApplyResult(await applyThemeDocument(context, base, ownCopy));
    return true;
  }

  // Keep mine. The write bumps past the pulled vector, and the next sync pushes it.
  await writeSavedTheme(context, workingTheme.savedThemeId, workingTheme.theme, workingTheme.takenFromSources);
  workingThemeByBase.delete(base);

  return true;
}
