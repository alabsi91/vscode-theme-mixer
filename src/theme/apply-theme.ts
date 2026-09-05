import * as vscode from "vscode";

import {
  CONTRIBUTED_THEME_IDS,
  classifyGeneratedThemeWriteError,
  getErrorMessage,
  writeGeneratedTheme,
} from "./generated-theme-file.ts";

import type { ColorThemeDocument, ThemeBaseKind } from "./generated-theme-file.ts";
import type { GeneratedThemeRestoreFailureReason } from "./theme-storage.ts";

export type ApplyThemeFailureReason = GeneratedThemeRestoreFailureReason | "color-theme-setting-not-written";

export type ApplyThemeResult = { isApplied: true } | { isApplied: false; reason: ApplyThemeFailureReason; message: string };

const APPLY_DEBOUNCE_MILLISECONDS = 50;

interface PendingApply {
  theme: ColorThemeDocument;
  timer: ReturnType<typeof setTimeout>;
  resolveResult: (result: ApplyThemeResult) => void;
  result: Promise<ApplyThemeResult>;
}

const pendingAppliesByBase = new Map<ThemeBaseKind, PendingApply>();

const writesInFlightByBase = new Map<ThemeBaseKind, Promise<ApplyThemeResult>>();

/** Never changes `workbench.colorTheme`. Calls within 50ms for the same base collapse into one write. Never rejects. */
export function applyThemeDocument(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  theme: ColorThemeDocument
): Promise<ApplyThemeResult> {
  const pendingApply = pendingAppliesByBase.get(base);

  if (pendingApply) {
    pendingApply.theme = theme;
    return pendingApply.result;
  }

  const { promise: result, resolve: resolveResult } = Promise.withResolvers<ApplyThemeResult>();

  const timer = setTimeout(() => {
    const readyApply = pendingAppliesByBase.get(base);
    if (!readyApply) return;

    pendingAppliesByBase.delete(base);
    void queueWriteTheme(context, base, readyApply.theme).then(readyApply.resolveResult);
  }, APPLY_DEBOUNCE_MILLISECONDS);

  pendingAppliesByBase.set(base, { theme, timer, resolveResult, result });

  return result;
}

/** Follows the switch only when the window is already on one of the editor's themes. Never rejects. */
export async function switchThemeBase(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  theme: ColorThemeDocument
): Promise<ApplyThemeResult> {
  // A debounced apply still waiting for this base holds an older document and must not fire after the switch.
  const supersededApply = pendingAppliesByBase.get(base);

  if (supersededApply) {
    clearTimeout(supersededApply.timer);
    pendingAppliesByBase.delete(base);
  }

  const writeResult = await queueWriteTheme(context, base, theme);
  supersededApply?.resolveResult(writeResult);

  if (!writeResult.isApplied || !isAnyEditorThemeShowing()) {
    return writeResult;
  }

  return showEditorTheme(base);
}

export function isEditorThemeShowing(base: ThemeBaseKind): boolean {
  return getShowingThemeId() === CONTRIBUTED_THEME_IDS[base];
}

export function showEditorTheme(base: ThemeBaseKind): Promise<ApplyThemeResult> {
  return showTheme(CONTRIBUTED_THEME_IDS[base]);
}

/** The one place the user's theme gets changed, and only because they asked. Fails when a workspace setting outranks it. */
export async function showTheme(settingsId: string): Promise<ApplyThemeResult> {
  try {
    await selectTheme(settingsId);
  } catch (error) {
    return { isApplied: false, reason: "color-theme-setting-not-written", message: getErrorMessage(error) };
  }

  return { isApplied: true };
}

function isAnyEditorThemeShowing(): boolean {
  const showingThemeId = getShowingThemeId();

  return showingThemeId === CONTRIBUTED_THEME_IDS.dark || showingThemeId === CONTRIBUTED_THEME_IDS.light;
}

function getShowingThemeId(): string | undefined {
  return vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
}

// Two writes to the same file at once can leave it truncated. Each base gets one chain.
function queueWriteTheme(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  theme: ColorThemeDocument
): Promise<ApplyThemeResult> {
  const previousWrite = writesInFlightByBase.get(base) ?? Promise.resolve();
  const write = previousWrite.then(() => writeThemeFile(context, base, theme));

  writesInFlightByBase.set(base, write);

  return write;
}

async function writeThemeFile(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  theme: ColorThemeDocument
): Promise<ApplyThemeResult> {
  try {
    await writeGeneratedTheme(context, base, theme);
  } catch (error) {
    return { isApplied: false, ...classifyGeneratedThemeWriteError(error) };
  }

  return { isApplied: true };
}

// Only the user's own value is written, and only when it differs. Anything else churns settings.json for nothing.
async function selectTheme(settingsId: string): Promise<void> {
  const workbenchConfig = vscode.workspace.getConfiguration("workbench");
  const userSelectedThemeId = workbenchConfig.inspect<string>("colorTheme")?.globalValue;

  if (userSelectedThemeId !== settingsId) {
    await workbenchConfig.update("colorTheme", settingsId, vscode.ConfigurationTarget.Global);
  }

  // A workspace or folder setting outranks the user's own. The write above changed nothing the user can see.
  const workbenchConfigAfterUpdate = vscode.workspace.getConfiguration("workbench");
  const effectivelySelectedThemeId = workbenchConfigAfterUpdate.get<string>("colorTheme");
  if (effectivelySelectedThemeId === settingsId) return;

  const overridingScopeName = getOverridingColorThemeScopeName(workbenchConfigAfterUpdate);
  const overridingScopeMessage =
    `workbench.colorTheme is set at ${overridingScopeName} scope to "${effectivelySelectedThemeId}". ` +
    "That outranks the user setting, and the window keeps showing it.";

  throw new Error(overridingScopeMessage);
}

function getOverridingColorThemeScopeName(workbenchConfig: vscode.WorkspaceConfiguration): string {
  const colorThemeSetting = workbenchConfig.inspect<string>("colorTheme");

  if (colorThemeSetting?.workspaceFolderValue !== undefined) {
    return "workspace folder";
  }

  if (colorThemeSetting?.workspaceValue !== undefined) {
    return "workspace";
  }

  return "a narrower";
}
