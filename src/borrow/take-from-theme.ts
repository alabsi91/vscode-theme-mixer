import * as vscode from "vscode";

import { SYNTAX_HIGHLIGHTING_TAKE_TARGET_ID, WHOLE_THEME_TAKE_TARGET_ID } from "../panel/webview-protocol.ts";
import { applyThemeDocument } from "../theme/apply-theme.ts";
import { getTakenFromSources, runStorageOperation, writeSavedThemeFileAndEntry } from "../theme/theme-storage.ts";
import { getColorIdsInBucket } from "../theme/workbench-color-catalog.ts";
import { getWorkingTheme, openActiveSavedThemeInChain, openEditableTheme, recordApplyResult } from "../theme/working-theme.ts";
import { listInstalledColorThemes, loadInstalledColorTheme } from "./installed-themes.ts";
import { pickThemeWithLivePreview } from "./pick-and-take.ts";

import type { ColorThemeDocument, ThemeBaseKind } from "../theme/generated-theme-file.ts";
import type { TakenFromSource } from "../theme/theme-storage.ts";
import type { CountSourceColors, CreateCandidateTheme } from "./pick-and-take.ts";

/** One part that can be copied out of another theme: a color bucket, the code colors, or the whole theme. */
export interface TakeTarget {
  take: CreateCandidateTheme;
  countSourceColors: CountSourceColors;
}

export const SYNTAX_HIGHLIGHTING_LABEL = "Syntax Highlighting";

const syntaxHighlightingTakeTarget: TakeTarget = {
  take: (currentTheme, sourceTheme) => ({
    ...currentTheme,
    tokenColors: [...sourceTheme.tokenColors],
    semanticTokenColors: { ...sourceTheme.semanticTokenColors },
    semanticHighlighting: sourceTheme.semanticHighlighting,
  }),
  countSourceColors: sourceTheme => sourceTheme.tokenColors.length,
};

export async function getTakeTarget(context: vscode.ExtensionContext, takeTargetId: string): Promise<TakeTarget> {
  if (takeTargetId === SYNTAX_HIGHLIGHTING_TAKE_TARGET_ID) {
    return syntaxHighlightingTakeTarget;
  }

  const colorIdsInBucket = await getColorIdsInBucket(context, takeTargetId);

  return {
    take: (currentTheme, sourceTheme) => {
      const candidateTheme = structuredClone(currentTheme);

      for (const colorId of colorIdsInBucket) {
        const sourceValue = sourceTheme.colors[colorId];

        if (sourceValue === undefined) {
          delete candidateTheme.colors[colorId];
          continue;
        }

        candidateTheme.colors[colorId] = sourceValue;
      }

      return candidateTheme;
    },
    countSourceColors: sourceTheme => colorIdsInBucket.filter(colorId => sourceTheme.colors[colorId] !== undefined).length,
  };
}

/** Parts the user took from somewhere else on purpose are put back on top of the new whole theme. */
export async function createWholeThemeTakeTarget(context: vscode.ExtensionContext, base: ThemeBaseKind): Promise<TakeTarget> {
  const { takenFromSources } = await openEditableTheme(context, base);
  const pinnedTakeTargetIds = Object.keys(takenFromSources).filter(takeTargetId => takeTargetId !== WHOLE_THEME_TAKE_TARGET_ID);
  const pinnedTakeTargets = await Promise.all(pinnedTakeTargetIds.map(takeTargetId => getTakeTarget(context, takeTargetId)));

  return {
    take: (currentTheme, sourceTheme) => {
      let candidateTheme: ColorThemeDocument = {
        ...currentTheme,
        colors: { ...sourceTheme.colors },
        tokenColors: [...sourceTheme.tokenColors],
        semanticTokenColors: { ...sourceTheme.semanticTokenColors },
        semanticHighlighting: sourceTheme.semanticHighlighting,
      };

      for (const pinnedTakeTarget of pinnedTakeTargets) {
        candidateTheme = pinnedTakeTarget.take(candidateTheme, currentTheme);
      }

      return candidateTheme;
    },
    countSourceColors: sourceTheme => Object.keys(sourceTheme.colors).length,
  };
}

export async function pickAndTake(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  takeTargetId: string,
  takeTarget: TakeTarget
): Promise<void> {
  const editableTheme = await openEditableTheme(context, base);
  const pickedTheme = await pickThemeWithLivePreview(
    context,
    base,
    editableTheme.theme,
    takeTarget.take,
    takeTarget.countSourceColors
  );

  // Cancelling already put the previous theme back.
  if (!pickedTheme) return;

  const takenFromSource: TakenFromSource = { label: pickedTheme.sourceThemeLabel, settingsId: pickedTheme.sourceSettingsId };

  await commitTake(context, base, takeTargetId, takeTarget, pickedTheme.sourceTheme, takenFromSource);
}

export async function restoreTakeTargetFromWholeTheme(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  takeTargetId: string
): Promise<void> {
  const { takenFromSources } = await openEditableTheme(context, base);

  const wholeThemeSource = takenFromSources[WHOLE_THEME_TAKE_TARGET_ID];
  if (!wholeThemeSource) return;

  const installedColorThemes = await listInstalledColorThemes();
  const installedTheme = installedColorThemes.find(candidate => candidate.settingsId === wholeThemeSource.settingsId);

  if (!installedTheme) {
    void vscode.window.showErrorMessage(`Theme Mixer: "${wholeThemeSource.label}" is no longer installed.`);
    return;
  }

  const wholeTheme = await loadInstalledColorTheme(installedTheme);
  const takeTarget = await getTakeTarget(context, takeTargetId);

  await commitTake(context, base, takeTargetId, takeTarget, wholeTheme, null);
}

// A take goes to the saved theme straight away. The picker's Enter was the moment of choice. Manual edits stay unsaved on top.
// A null takenFromSource forgets the note, which is what putting a part back means.
async function commitTake(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  takeTargetId: string,
  takeTarget: TakeTarget,
  sourceTheme: ColorThemeDocument,
  takenFromSource: TakenFromSource | null
): Promise<void> {
  // A sync pull must not land between the read and the write.
  const savedThemeWithTake = await runStorageOperation(async () => {
    const { savedThemeId, theme: savedTheme } = await openActiveSavedThemeInChain(context, base);
    const themeWithTake = takeTarget.take(savedTheme, sourceTheme);

    const savedSources = { ...(await getTakenFromSources(context, savedThemeId)) };
    applyTakenFromSource(savedSources, takeTargetId, takenFromSource);

    await writeSavedThemeFileAndEntry(context, savedThemeId, themeWithTake, savedSources);

    return themeWithTake;
  });

  const workingTheme = getWorkingTheme(base);

  if (workingTheme) {
    workingTheme.theme = takeTarget.take(workingTheme.theme, sourceTheme);
    applyTakenFromSource(workingTheme.takenFromSources, takeTargetId, takenFromSource);
  }

  recordApplyResult(await applyThemeDocument(context, base, workingTheme?.theme ?? savedThemeWithTake));
}

function applyTakenFromSource(
  takenFromSources: Record<string, TakenFromSource>,
  takeTargetId: string,
  takenFromSource: TakenFromSource | null
): void {
  if (takenFromSource === null) {
    delete takenFromSources[takeTargetId];
    return;
  }

  takenFromSources[takeTargetId] = takenFromSource;
}
