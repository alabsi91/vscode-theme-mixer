import * as vscode from "vscode";

import { watchInstalledColorThemes } from "./borrow/installed-themes.ts";
import {
  SYNTAX_HIGHLIGHTING_LABEL,
  createWholeThemeTakeTarget,
  getTakeTarget,
  pickAndTake,
  restoreTakeTargetFromWholeTheme,
} from "./borrow/take-from-theme.ts";
import { registerThemeEditorView } from "./panel/theme-editor-view.ts";
import { SYNTAX_HIGHLIGHTING_TAKE_TARGET_ID, WHOLE_THEME_TAKE_TARGET_ID } from "./panel/webview-protocol.ts";
import { disableSync, enableSync, getSyncState, onDidChangeSyncState, requestSync, startThemeSync } from "./sync/theme-sync.ts";
import {
  appendTokenColorRule,
  createTokenColorRuleViews,
  deleteTokenColorRule,
  isTokenInspectionEnabled,
  refreshTokenInspection,
  setTokenColorRule,
  setTokenInspectionEnabled,
} from "./syntax/token-colors.ts";
import { isSameAdjustments, normalizeColorAdjustments, setColorAdjustments } from "./theme/adjust-colors.ts";
import { applyThemeDocument, isEditorThemeShowing, showEditorTheme, switchThemeBase } from "./theme/apply-theme.ts";
import { composeAdjustedTheme } from "./theme/compose-adjusted-theme.ts";
import {
  exportThemeAsExtension,
  exportThemeAsJsonFile,
  exportThemeAsVsix,
  installThemeAsExtension,
} from "./theme/export-theme.ts";
import { createEmptyTheme } from "./theme/generated-theme-file.ts";
import { HEX_COLOR_PATTERN } from "./theme/hex-color.ts";
import {
  createSavedThemeId,
  deleteSavedTheme,
  duplicateSavedTheme,
  listSavedThemes,
  readSavedTheme,
  renameSavedTheme,
  restoreGeneratedThemeFiles,
  setActiveSavedThemeId,
  writeSavedTheme,
} from "./theme/theme-storage.ts";
import { createColorCategoryViews } from "./theme/workbench-color-catalog.ts";
import {
  DEFAULT_NEW_THEME_NAME,
  beginEdit,
  discardWorkingTheme,
  getEditingBase,
  getMostRecentApplyFailure,
  getWorkingTheme,
  hasUnsavedChanges,
  openEditableTheme,
  openExportableTheme,
  recordApplyFailure,
  recordApplyResult,
  revertColors,
  saveWorkingTheme,
  setEditingBase,
  settleUnsavedChanges,
} from "./theme/working-theme.ts";

import type { ThemeEditorViewProvider } from "./panel/theme-editor-view.ts";
import type { ColorCategoryView, EditorState, SavedThemeView, WebviewToExtensionMessage } from "./panel/webview-protocol.ts";
import type { ColorThemeDocument, ThemeBaseKind } from "./theme/generated-theme-file.ts";

export async function activate(context: vscode.ExtensionContext) {
  const restoreFailures = await restoreGeneratedThemeFiles(context);

  if (restoreFailures.length > 0) {
    recordApplyFailure(restoreFailures.map(failure => (failure.base ? `${failure.base}: ` : "") + failure.message).join("\n"));
  }

  const themeEditorView = registerThemeEditorView(context, {
    getEditorState: () => createEditorState(context),
    handleWebviewMessage: message => handleWebviewMessage(context, message, () => themeEditorView),
  });

  context.subscriptions.push(
    watchInstalledColorThemes(),
    startThemeSync(context),

    onDidChangeSyncState(() => void themeEditorView.sendState()),

    // The theme event fires before the setting lands, and the panel reads the setting. Both are needed.
    vscode.window.onDidChangeActiveColorTheme(() => void themeEditorView.sendState()),

    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("workbench.colorTheme")) {
        void themeEditorView.sendState();
      }
    }),

    vscode.commands.registerCommand("themeEditor.open", () => vscode.commands.executeCommand("themeEditor.panel.focus")),

    vscode.commands.registerCommand("themeEditor.exportTheme", async () => {
      const base = getEditingBase(context);
      const theme = await openExportableTheme(context, base);

      await exportThemeAsExtension(theme, base, context.extensionUri);
    })
  );
}

export function deactivate() {}

async function createEditorState(context: vscode.ExtensionContext): Promise<EditorState> {
  const base = getEditingBase(context);
  const { savedThemeId, theme, savedTheme, takenFromSources } = await openEditableTheme(context, base);

  const savedThemeSummaries = await listSavedThemes(context);
  const savedThemes: SavedThemeView[] = savedThemeSummaries
    .filter(summary => summary.base === base)
    .map(summary => ({ id: summary.id, name: summary.name, base: summary.base, isActive: summary.id === savedThemeId }));

  // A theme that a sync pull deleted stays on screen while its edits are unsaved. It is a tombstone, so the list left it out.
  if (savedThemes.every(savedTheme => !savedTheme.isActive)) {
    savedThemes.unshift({ id: savedThemeId, name: theme.name, base, isActive: true });
  }

  const wholeThemeSource = takenFromSources[WHOLE_THEME_TAKE_TARGET_ID];

  const adjustedTheme = await composeAdjustedTheme(context, theme);
  const categoryViews = await createColorCategoryViews(context, theme, base, adjustedTheme, savedTheme);

  // Not a workbench bucket. A row to borrow from, no keys to browse.
  const syntaxHighlightingCategory: ColorCategoryView = {
    id: SYNTAX_HIGHLIGHTING_TAKE_TARGET_ID,
    label: SYNTAX_HIGHLIGHTING_LABEL,
    keys: [],
    canImportFromTheme: true,
    takenFromThemeLabel: null,
  };

  const categories = [syntaxHighlightingCategory, ...categoryViews].map(category => ({
    ...category,
    takenFromThemeLabel: takenFromSources[category.id]?.label ?? wholeThemeSource?.label ?? null,
  }));

  return {
    base,
    savedThemes,
    categories,
    tokenColorRules: createTokenColorRuleViews(theme),
    isTokenInspectionEnabled: isTokenInspectionEnabled(),
    wholeThemeTakenFromLabel: wholeThemeSource?.label ?? null,
    // A hand-edited or corrupt file must not reach the sliders as it is.
    colorAdjustments: normalizeColorAdjustments(theme.colorAdjustments),
    hasUnsavedChanges: hasUnsavedChanges(base),
    isEditorThemeShowing: isEditorThemeShowing(base),
    applyFailure: getMostRecentApplyFailure(),
    syncState: getSyncState(),
  };
}

async function handleWebviewMessage(
  context: vscode.ExtensionContext,
  message: WebviewToExtensionMessage,
  getThemeEditorView: () => ThemeEditorViewProvider
): Promise<void> {
  const base = getEditingBase(context);

  switch (message.kind) {
    case "saveTheme": {
      await saveWorkingTheme(context, base);
      break;
    }

    case "discardChanges": {
      await discardWorkingTheme(context, base);
      break;
    }

    case "showEditorTheme": {
      recordApplyResult(await showEditorTheme(base));
      break;
    }

    case "showSavedTheme": {
      const { savedTheme } = await openEditableTheme(context, base);
      recordApplyResult(await applyThemeDocument(context, base, savedTheme));
      break;
    }

    case "showWorkingTheme": {
      const { theme } = await openEditableTheme(context, base);
      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "exportTheme": {
      const theme = await openExportableTheme(context, base);
      await exportThemeAsExtension(theme, base, context.extensionUri);
      break;
    }

    case "exportThemeJson": {
      const theme = await openExportableTheme(context, base);
      await exportThemeAsJsonFile(theme);
      break;
    }

    case "exportThemeVsix": {
      const theme = await openExportableTheme(context, base);
      await exportThemeAsVsix(theme, base, context.extensionUri);
      break;
    }

    case "installTheme": {
      const theme = await openExportableTheme(context, base);
      await installThemeAsExtension(theme, base, context);
      break;
    }

    case "setBase": {
      if (message.base === base) break;
      if (!(await settleUnsavedChanges(context, base))) break;

      await setEditingBase(context, message.base);

      const { theme } = await openEditableTheme(context, message.base);
      recordApplyResult(await switchThemeBase(context, message.base, theme));
      break;
    }

    case "setColor": {
      const { theme } = await beginEdit(context, base);

      if (message.value === null) {
        delete theme.colors[message.colorId];
      } else {
        theme.colors[message.colorId] = message.value;
      }

      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "replaceColors": {
      const { theme } = await beginEdit(context, base);

      for (const [colorId, value] of Object.entries(message.colors)) {
        if (HEX_COLOR_PATTERN.test(value)) {
          theme.colors[colorId] = value;
        }
      }

      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "revertColors": {
      await revertColors(context, base, message.colorIds);
      break;
    }

    case "setColorAdjustments": {
      const colorAdjustments = normalizeColorAdjustments(message.colorAdjustments);

      // Reset while already at zero must not mark the theme dirty.
      const { theme: currentTheme } = await openEditableTheme(context, base);
      const currentColorAdjustments = normalizeColorAdjustments(currentTheme.colorAdjustments);
      if (isSameAdjustments(currentColorAdjustments, colorAdjustments)) break;

      const { theme } = await beginEdit(context, base);
      setColorAdjustments(theme, colorAdjustments);

      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "flashColor": {
      const { theme } = await openEditableTheme(context, base);
      await flashColor(context, base, theme, message.colorId);
      break;
    }

    case "selectSavedTheme": {
      if (!(await settleUnsavedChanges(context, base))) break;

      // Read first. A theme whose file is gone must not become the active one.
      const theme = await readSavedTheme(context, message.savedThemeId);

      await setActiveSavedThemeId(context, base, message.savedThemeId);
      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "createSavedTheme": {
      if (!(await settleUnsavedChanges(context, base))) break;

      const savedThemeId = createSavedThemeId();
      const theme = createEmptyTheme(base);
      theme.name = message.name || DEFAULT_NEW_THEME_NAME;

      await writeSavedTheme(context, savedThemeId, theme, {});
      await setActiveSavedThemeId(context, base, savedThemeId);
      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "renameSavedTheme": {
      await renameSavedTheme(context, message.savedThemeId, message.name);

      // Save writes the unsaved copy whole. One that still carries the old name would undo the rename.
      const workingTheme = getWorkingTheme(base);
      if (workingTheme?.savedThemeId === message.savedThemeId) {
        workingTheme.theme.name = message.name;
      }

      break;
    }

    case "duplicateSavedTheme": {
      if (!(await settleUnsavedChanges(context, base))) break;

      const duplicateThemeId = await duplicateSavedTheme(context, message.savedThemeId);
      await setActiveSavedThemeId(context, base, duplicateThemeId);

      const theme = await readSavedTheme(context, duplicateThemeId);
      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "deleteSavedTheme": {
      const isConfirmed = await confirmDeleteSavedTheme(context, message.savedThemeId);
      if (!isConfirmed) break;

      await deleteSavedTheme(context, message.savedThemeId);

      // Unsaved edits to the deleted theme go with it. Edits to any other theme stay on screen.
      const { theme } = await openEditableTheme(context, base);
      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "setTokenColorRule": {
      const { theme } = await beginEdit(context, base);
      setTokenColorRule(theme, message.ruleIndex, message);

      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "createTokenColorRuleForScope": {
      const { theme } = await beginEdit(context, base);
      appendTokenColorRule(theme, message.scope, message.foreground);

      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "deleteTokenColorRule": {
      const { theme } = await beginEdit(context, base);
      deleteTokenColorRule(theme, message.ruleIndex);

      recordApplyResult(await applyThemeDocument(context, base, theme));
      break;
    }

    case "setTokenInspectionEnabled": {
      setTokenInspectionEnabled(context, message.isEnabled, getThemeEditorView);
      break;
    }

    case "restoreCategoryFromWholeTheme": {
      await restoreTakeTargetFromWholeTheme(context, base, message.categoryId);
      break;
    }

    case "pickAndTakeWholeTheme": {
      const wholeThemeTakeTarget = await createWholeThemeTakeTarget(context, base);
      await pickAndTake(context, base, WHOLE_THEME_TAKE_TARGET_ID, wholeThemeTakeTarget);
      break;
    }

    case "pickAndTakeCategory": {
      const takeTarget = await getTakeTarget(context, message.categoryId);
      await pickAndTake(context, base, message.categoryId, takeTarget);
      break;
    }

    case "enableSync": {
      await enableSync(context);
      break;
    }

    case "syncNow": {
      await requestSync(context);
      break;
    }

    case "disableSync": {
      await disableSync(context);
      break;
    }
  }

  refreshTokenInspection(context, getThemeEditorView);
}

const FLASH_COLOR = "#ff00ff";

const FLASH_BLINK_COUNT = 2;

const FLASH_BLINK_MILLISECONDS = 320;

async function flashColor(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  theme: ColorThemeDocument,
  colorId: string
): Promise<void> {
  const flashingTheme = structuredClone(theme);
  flashingTheme.colors[colorId] = FLASH_COLOR;

  for (let blink = 0; blink < FLASH_BLINK_COUNT; blink++) {
    await applyThemeDocument(context, base, flashingTheme);
    await waitFor(FLASH_BLINK_MILLISECONDS);

    // An edit can land while the color is lit. Putting back the document from before the blink would undo it.
    const { theme: currentTheme } = await openEditableTheme(context, base);
    await applyThemeDocument(context, base, currentTheme);
    await waitFor(FLASH_BLINK_MILLISECONDS);
  }
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function confirmDeleteSavedTheme(context: vscode.ExtensionContext, savedThemeId: string): Promise<boolean> {
  const savedThemes = await listSavedThemes(context);
  const savedTheme = savedThemes.find(candidate => candidate.id === savedThemeId);

  if (!savedTheme) {
    return false;
  }

  const deleteAction = "Delete";
  const chosenAction = await vscode.window.showWarningMessage(
    `Delete "${savedTheme.name}"? This cannot be undone.`,
    { modal: true },
    deleteAction
  );

  return chosenAction === deleteAction;
}
