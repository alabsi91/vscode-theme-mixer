import * as vscode from "vscode";

import { composeAdjustedTheme } from "./compose-adjusted-theme.ts";

import type { ColorAdjustment } from "./adjust-colors.ts";

export interface ColorThemeDocument {
  name: string;
  type: "dark" | "light";
  semanticHighlighting: boolean;
  colors: Record<string, string>;
  semanticTokenColors: Record<string, unknown>;
  tokenColors: unknown[];
  /** Editor-only. Keyed by take target id. Removed when the theme leaves the editor. */
  colorAdjustments?: Record<string, ColorAdjustment>;
}

export type ThemeBaseKind = "dark" | "light";

export const CONTRIBUTED_THEME_IDS: Record<ThemeBaseKind, string> = {
  dark: "Theme Editor (Dark)",
  light: "Theme Editor (Light)",
};

export type GeneratedThemeWriteFailureReason = "install-directory-not-writable" | "generated-theme-not-written";

const GENERATED_THEME_PATHS: Record<ThemeBaseKind, string> = {
  dark: "themes/generated-dark.json",
  light: "themes/generated-light.json",
};

const PERMISSION_ERRNO_PATTERN = /\b(?:EROFS|EACCES|EPERM)\b/;

export function getGeneratedThemeUri(context: vscode.ExtensionContext, base: ThemeBaseKind): vscode.Uri {
  return vscode.Uri.joinPath(context.extensionUri, GENERATED_THEME_PATHS[base]);
}

/**
 * Overwrite in place. A temp file renamed over the target arrives as a create, and VS Code ignores it. The `name` is replaced
 * with the contributed id. A write whose bytes match the file is skipped, or startup flashes.
 */
export async function writeGeneratedTheme(
  context: vscode.ExtensionContext,
  base: ThemeBaseKind,
  theme: ColorThemeDocument
): Promise<void> {
  const composedTheme = await composeAdjustedTheme(context, theme);
  const themeNamedAfterItsContribution: ColorThemeDocument = { ...composedTheme, name: CONTRIBUTED_THEME_IDS[base] };

  const uri = getGeneratedThemeUri(context, base);
  const contents = new TextEncoder().encode(JSON.stringify(themeNamedAfterItsContribution, null, 2));

  if (await isFileContentEqual(uri, contents)) return;

  await vscode.workspace.fs.writeFile(uri, contents);
}

/** Replaces missing or wrong parts with empty ones. A hand-edited file loses only what it got wrong. */
export function normalizeColorThemeDocument(value: unknown): ColorThemeDocument {
  const record = isPlainRecord(value) ? value : {};
  const type = record.type === "light" ? "light" : "dark";

  const theme: ColorThemeDocument = {
    name: typeof record.name === "string" ? record.name : CONTRIBUTED_THEME_IDS[type],
    type,
    semanticHighlighting: record.semanticHighlighting === true,
    colors: isPlainRecord(record.colors) ? (record.colors as Record<string, string>) : {},
    semanticTokenColors: isPlainRecord(record.semanticTokenColors) ? record.semanticTokenColors : {},
    tokenColors: Array.isArray(record.tokenColors) ? record.tokenColors : [],
  };

  if (isPlainRecord(record.colorAdjustments)) {
    theme.colorAdjustments = record.colorAdjustments as Record<string, ColorAdjustment>;
  }

  return theme;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyGeneratedThemeWriteError(error: unknown): {
  reason: GeneratedThemeWriteFailureReason;
  message: string;
} {
  const reason = isPermissionError(error) ? "install-directory-not-writable" : "generated-theme-not-written";

  return { reason, message: getErrorMessage(error) };
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isFileContentEqual(uri: vscode.Uri, contents: Uint8Array): Promise<boolean> {
  let existingContents: Uint8Array;

  try {
    existingContents = await vscode.workspace.fs.readFile(uri);
  } catch {
    return false;
  }

  if (existingContents.length !== contents.length) {
    return false;
  }

  return existingContents.every((byte, index) => byte === contents[index]);
}

// VS Code maps EACCES and EPERM to NoPermissions. EROFS from a read-only volume stays a raw errno.
function isPermissionError(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError && error.code === "NoPermissions") {
    return true;
  }

  const errorCode = (error as { code?: unknown })?.code;
  if (typeof errorCode === "string" && PERMISSION_ERRNO_PATTERN.test(errorCode)) {
    return true;
  }

  return PERMISSION_ERRNO_PATTERN.test(getErrorMessage(error));
}

export function createEmptyTheme(base: ThemeBaseKind): ColorThemeDocument {
  return {
    name: CONTRIBUTED_THEME_IDS[base],
    type: base,
    semanticHighlighting: true,
    colors: {},
    semanticTokenColors: {},
    tokenColors: [],
  };
}
