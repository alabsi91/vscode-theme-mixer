import * as vscode from "vscode";

import { SYNTAX_HIGHLIGHTING_TAKE_TARGET_ID, WHOLE_THEME_TAKE_TARGET_ID } from "../panel/webview-protocol.ts";
import { adjustThemeColors, normalizeColorAdjustments } from "./adjust-colors.ts";
import { getColorIdsInBucket } from "./workbench-color-catalog.ts";

import type { AdjustmentStep } from "./adjust-colors.ts";
import type { ColorThemeDocument } from "./generated-theme-file.ts";

/**
 * The theme as it leaves the editor. The sliders are baked into the colors and `colorAdjustments` is gone. The catalog is only
 * read for a bucket row that is off center, so a theme without one never pays for it at startup.
 */
export async function composeAdjustedTheme(
  context: vscode.ExtensionContext,
  theme: ColorThemeDocument
): Promise<ColorThemeDocument> {
  const steps: AdjustmentStep[] = [];
  let wholeThemeStep: AdjustmentStep | undefined;

  const adjustmentEntries = Object.entries(normalizeColorAdjustments(theme.colorAdjustments));

  for (const [takeTargetId, adjustment] of adjustmentEntries) {
    if (takeTargetId === WHOLE_THEME_TAKE_TARGET_ID) {
      wholeThemeStep = { colorIds: Object.keys(theme.colors), includesSyntax: true, adjustment };
      continue;
    }

    if (takeTargetId === SYNTAX_HIGHLIGHTING_TAKE_TARGET_ID) {
      steps.push({ colorIds: [], includesSyntax: true, adjustment });
      continue;
    }

    // A bucket this catalog does not know is skipped.
    const colorIds = await getColorIdsInBucket(context, takeTargetId);
    if (colorIds.length === 0) continue;

    steps.push({ colorIds, includesSyntax: false, adjustment });
  }

  // Buckets are disjoint. The whole theme goes on top of them.
  if (wholeThemeStep) {
    steps.push(wholeThemeStep);
  }

  return adjustThemeColors(theme, steps);
}
