import * as vscode from "vscode";

import { applyThemeDocument } from "../theme/apply-theme.ts";
import { getBaseKindForUiTheme, listInstalledColorThemes, loadInstalledColorTheme } from "./installed-themes.ts";

import type { ColorThemeDocument, ThemeBaseKind } from "../theme/generated-theme-file.ts";
import type { InstalledColorTheme } from "./installed-themes.ts";

export type CreateCandidateTheme = (currentTheme: ColorThemeDocument, sourceTheme: ColorThemeDocument) => ColorThemeDocument;

/** Shown beside each theme in the picker. A theme that offers nothing is left out. */
export type CountSourceColors = (sourceTheme: ColorThemeDocument) => number;

interface ThemePickItem extends vscode.QuickPickItem {
  sourceTheme: ColorThemeDocument;
  sourceSettingsId: string;
  isSameBase: boolean;
}

export interface PickedTheme {
  sourceTheme: ColorThemeDocument;
  sourceThemeLabel: string;
  sourceSettingsId: string;
}

/** Previews each theme live as the user moves through the list. Escape puts back what was there. Undefined on cancel. */
export async function pickThemeWithLivePreview(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  currentTheme: ColorThemeDocument,
  createCandidateTheme: CreateCandidateTheme,
  countSourceColors: CountSourceColors
): Promise<PickedTheme | undefined> {
  const pickItems = await createThemePickItems(base, countSourceColors);

  if (pickItems.length === 0) {
    void vscode.window.showInformationMessage("Theme Editor: no other installed theme offers colors here.");
    return undefined;
  }

  const quickPick = vscode.window.createQuickPick<ThemePickItem>();
  quickPick.items = pickItems;
  quickPick.placeholder = "Move to preview, Enter to keep, Escape to cancel";
  quickPick.matchOnDescription = true;

  const previewTheme = (theme: ColorThemeDocument) => void applyThemeDocument(context, base, theme);

  return await new Promise<PickedTheme | undefined>(resolve => {
    let pickedTheme: PickedTheme | undefined;

    quickPick.onDidChangeActive(activeItems => {
      const activeItem = activeItems[0];
      if (!activeItem) return;

      previewTheme(createCandidateTheme(currentTheme, activeItem.sourceTheme));
    });

    quickPick.onDidAccept(() => {
      const selectedItem = quickPick.selectedItems[0];
      if (selectedItem) {
        pickedTheme = {
          sourceTheme: selectedItem.sourceTheme,
          sourceThemeLabel: selectedItem.label,
          sourceSettingsId: selectedItem.sourceSettingsId,
        };
      }

      quickPick.hide();
    });

    quickPick.onDidHide(() => {
      // Every move through the list already painted. Cancelling has to undo the last one.
      if (!pickedTheme) {
        previewTheme(currentTheme);
      }

      quickPick.dispose();
      resolve(pickedTheme);
    });

    quickPick.show();
  });
}

async function createThemePickItems(base: ThemeBaseKind, countSourceColors: CountSourceColors): Promise<ThemePickItem[]> {
  const installedColorThemes = await listInstalledColorThemes();

  const loadedThemes = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: "Theme Editor: reading installed themes" },
    () => Promise.all(installedColorThemes.map(installedTheme => loadThemeForPicking(installedTheme)))
  );

  const pickItems: ThemePickItem[] = [];

  for (const loadedTheme of loadedThemes) {
    if (!loadedTheme) continue;

    const colorCount = countSourceColors(loadedTheme.sourceTheme);
    if (colorCount === 0) continue;

    const sourceBase = getBaseKindForUiTheme(loadedTheme.installedTheme.uiTheme);

    pickItems.push({
      label: loadedTheme.installedTheme.label,
      description: `${loadedTheme.installedTheme.extensionDisplayName} · ${sourceBase}`,
      detail: `${colorCount} colors`,
      sourceTheme: loadedTheme.sourceTheme,
      sourceSettingsId: loadedTheme.installedTheme.settingsId,
      isSameBase: sourceBase === base,
    });
  }

  // The other base is offered too. A terminal palette or the code colors can fit either way.
  pickItems.sort((left, right) => Number(right.isSameBase) - Number(left.isSameBase) || left.label.localeCompare(right.label));

  return pickItems;
}

async function loadThemeForPicking(
  installedTheme: InstalledColorTheme
): Promise<{ installedTheme: InstalledColorTheme; sourceTheme: ColorThemeDocument } | undefined> {
  try {
    return { installedTheme, sourceTheme: await loadInstalledColorTheme(installedTheme) };
  } catch {
    return undefined;
  }
}
