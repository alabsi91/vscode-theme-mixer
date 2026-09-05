import type { ColorAdjustment } from "../theme/adjust-colors.ts";
import type { ThemeBaseKind } from "../theme/generated-theme-file.ts";

// The webview bundle imports these two at runtime. Everything else in this file stays type-only.

/** The code colors are `tokenColors` and `semanticTokenColors`. No workbench bucket holds those. */
export const SYNTAX_HIGHLIGHTING_TAKE_TARGET_ID = "*syntax-highlighting*";

export const WHOLE_THEME_TAKE_TARGET_ID = "*whole*";

export interface ColorKeyView {
  id: string;
  description: string;
  /** Null when the theme leaves the key to its default. */
  value: string | null;
  defaultValue: string | null;
  /** The value after the adjustment sliders. Same as `value` when no slider touches it. */
  adjustedValue: string | null;
}

export interface ColorCategoryView {
  id: string;
  label: string;
  keys: ColorKeyView[];
  /** False for the catch-all categories, which hold leftovers rather than a fixed set of keys. */
  canImportFromTheme: boolean;
  /** Null when the user has never taken this category. */
  takenFromThemeLabel: string | null;
}

export interface SavedThemeView {
  id: string;
  name: string;
  base: ThemeBaseKind;
  isActive: boolean;
}

export interface TokenColorRuleView {
  /** Position in the theme's `tokenColors` array. */
  index: number;
  name: string;
  scopes: string[];
  foreground: string | null;
  fontStyle: string | null;
}

export interface TokenInspectionView {
  text: string;
  /** Innermost last. */
  scopes: string[];
  /** Index into `tokenColors`. Null when the default applies. */
  winningRuleIndex: number | null;
  foreground: string | null;
  /** Set when a language server colors this token instead, which overrides the TextMate rule. */
  semanticTokenType: string | null;
}

export type SyncStatus = "off" | "syncing" | "on" | "paused" | "error";

export interface SyncState {
  status: SyncStatus;
  /** The GitHub account, once a session was seen. */
  accountLabel?: string;
  /** ISO 8601, this machine's clock. Informational only. */
  lastSyncedAt?: string;
  /** Shown under the status while paused or in error. */
  message?: string;
}

export interface EditorState {
  base: ThemeBaseKind;
  savedThemes: SavedThemeView[];
  categories: ColorCategoryView[];
  tokenColorRules: TokenColorRuleView[];
  /** The page is rebuilt on every open. The extension may still be following the cursor. */
  isTokenInspectionEnabled: boolean;
  wholeThemeTakenFromLabel: string | null;
  /** Take target id to sliders. A missing id means all zero. */
  colorAdjustments: Record<string, ColorAdjustment>;
  hasUnsavedChanges: boolean;
  /** Edits only repaint while this is true. */
  isEditorThemeShowing: boolean;
  applyFailure: string | null;
  syncState: SyncState;
}

export type ExtensionToWebviewMessage =
  { kind: "state"; state: EditorState } | { kind: "tokenInspection"; inspection: TokenInspectionView | null };

export type WebviewToExtensionMessage =
  | { kind: "ready" }
  | { kind: "saveTheme" }
  | { kind: "discardChanges" }
  | { kind: "showEditorTheme" }
  | { kind: "exportTheme" }
  | { kind: "exportThemeJson" }
  | { kind: "exportThemeVsix" }
  | { kind: "installTheme" }
  | { kind: "pickAndTakeWholeTheme" }
  | { kind: "pickAndTakeCategory"; categoryId: string }
  | { kind: "restoreCategoryFromWholeTheme"; categoryId: string }
  | { kind: "setBase"; base: ThemeBaseKind }
  | { kind: "setColor"; colorId: string; value: string | null }
  | { kind: "setColorAdjustment"; takeTargetId: string; adjustment: ColorAdjustment }
  | { kind: "flashColor"; colorId: string }
  | { kind: "selectSavedTheme"; savedThemeId: string }
  | { kind: "createSavedTheme"; name: string }
  | { kind: "renameSavedTheme"; savedThemeId: string; name: string }
  | { kind: "duplicateSavedTheme"; savedThemeId: string }
  | { kind: "deleteSavedTheme"; savedThemeId: string }
  /** Null clears that property. */
  | { kind: "setTokenColorRule"; ruleIndex: number; foreground?: string | null; fontStyle?: string | null }
  | { kind: "createTokenColorRuleForScope"; scope: string; foreground: string }
  | { kind: "deleteTokenColorRule"; ruleIndex: number }
  | { kind: "setTokenInspectionEnabled"; isEnabled: boolean }
  /** Also the Sign in button while sync is paused. */
  | { kind: "enableSync" }
  | { kind: "syncNow" }
  | { kind: "disableSync" };
