import { posix as posixPath } from "node:path";

import * as jsoncParser from "jsonc-parser";
import * as vscode from "vscode";

import { CONTRIBUTED_THEME_IDS } from "../theme/generated-theme-file.ts";

import type { ColorThemeDocument, ThemeBaseKind } from "../theme/generated-theme-file.ts";

export interface InstalledColorTheme {
  label: string;
  settingsId: string;
  /** One of `vs`, `vs-dark`, `hc-black` or `hc-light`. This is authoritative. The `type` inside the file is not. */
  uiTheme: string;
  extensionDisplayName: string;
  themeFileUri: vscode.Uri;
}

/** Themes that cannot be loaded are left out. That includes plists and the old `settings` format. */
export async function listInstalledColorThemes(): Promise<InstalledColorTheme[]> {
  const contributedThemes = collectContributedColorThemes();

  const loadableFlags = await Promise.all(contributedThemes.map(theme => isColorThemeLoadable(theme)));

  return contributedThemes.filter((_theme, index) => loadableFlags[index]);
}

/** The include chain resolved. The result is the caller's own copy. */
export async function loadInstalledColorTheme(theme: InstalledColorTheme): Promise<ColorThemeDocument> {
  return structuredClone(await readInstalledColorTheme(theme));
}

/** A reinstall can land in the same folder. The change event is the only signal. */
export function watchInstalledColorThemes(): vscode.Disposable {
  return vscode.extensions.onDidChange(() => themeDocumentByFileUriText.clear());
}

/** `vs` and `hc-light` are the light bases. Everything else is dark. */
export function getBaseKindForUiTheme(uiTheme: string): ThemeBaseKind {
  return uiTheme === "vs" || uiTheme === "hc-light" ? "light" : "dark";
}

interface ContributedThemeEntry {
  id?: string;
  label?: string;
  uiTheme?: string;
  path?: string;
}

interface ExtensionPackageJson {
  displayName?: string;
  name?: string;
  contributes?: { themes?: ContributedThemeEntry[] };
}

interface ThemeFileContents {
  include?: string;
  settings?: unknown;
  colors?: unknown;
  tokenColors?: unknown;
  semanticTokenColors?: unknown;
  semanticHighlighting?: boolean;
}

const EDITOR_THEME_SETTINGS_IDS: string[] = Object.values(CONTRIBUTED_THEME_IDS);

function collectContributedColorThemes(): InstalledColorTheme[] {
  const contributedThemes: InstalledColorTheme[] = [];

  for (const extension of vscode.extensions.all) {
    const packageJson = extension.packageJSON as ExtensionPackageJson;

    const themeEntries = packageJson.contributes?.themes;
    if (!Array.isArray(themeEntries)) continue;

    const extensionDisplayName = packageJson.displayName ?? packageJson.name ?? extension.id;

    for (const entry of themeEntries) {
      if (typeof entry?.path !== "string") continue;

      const label = entry.label || posixPath.basename(entry.path);
      const settingsId = entry.id || label;

      // The editor's own themes are the output. Offering them as a source would copy the paint back into itself.
      if (EDITOR_THEME_SETTINGS_IDS.includes(settingsId)) continue;

      contributedThemes.push({
        label,
        settingsId,
        uiTheme: entry.uiTheme ?? "vs-dark",
        extensionDisplayName,
        themeFileUri: vscode.Uri.joinPath(extension.extensionUri, entry.path),
      });
    }
  }

  return contributedThemes;
}

const themeDocumentByFileUriText = new Map<string, Promise<ColorThemeDocument>>();

function readInstalledColorTheme(theme: InstalledColorTheme): Promise<ColorThemeDocument> {
  const fileUriText = theme.themeFileUri.toString();

  const cachedThemeDocument = themeDocumentByFileUriText.get(fileUriText);
  if (cachedThemeDocument) {
    return cachedThemeDocument;
  }

  const themeDocument = resolveInstalledColorTheme(theme);
  themeDocumentByFileUriText.set(fileUriText, themeDocument);

  return themeDocument;
}

async function resolveInstalledColorTheme(theme: InstalledColorTheme): Promise<ColorThemeDocument> {
  const resolvedTheme: ColorThemeDocument = {
    name: theme.label,
    type: getBaseKindForUiTheme(theme.uiTheme),
    semanticHighlighting: false,
    colors: {},
    semanticTokenColors: {},
    tokenColors: [],
  };

  await applyThemeFile(theme.themeFileUri, resolvedTheme, new Set<string>());

  return resolvedTheme;
}

function isColorThemeLoadable(theme: InstalledColorTheme): Promise<boolean> {
  return readInstalledColorTheme(theme).then(
    () => true,
    () => false
  );
}

// VS Code has no cycle guard here. The visited set stops a theme that includes itself from hanging the host.
async function applyThemeFile(
  fileUri: vscode.Uri,
  resolvedTheme: ColorThemeDocument,
  visitedFileUriTexts: Set<string>
): Promise<void> {
  const fileUriText = fileUri.toString();
  if (visitedFileUriTexts.has(fileUriText)) return;

  visitedFileUriTexts.add(fileUriText);

  if (!isJsonThemeFile(fileUri)) {
    throw new Error(`${fileUri.fsPath} is a TextMate plist theme, which is not supported.`);
  }

  const themeFile = await readThemeFile(fileUri);

  if (Array.isArray(themeFile.settings)) {
    throw new TypeError(`${fileUri.fsPath} uses the old settings format, which is not supported.`);
  }

  if (typeof themeFile.include === "string") {
    await applyThemeFile(resolveSiblingFile(fileUri, themeFile.include), resolvedTheme, visitedFileUriTexts);
  }

  applyColors(themeFile.colors, resolvedTheme, fileUri);

  if (Array.isArray(themeFile.tokenColors)) {
    resolvedTheme.tokenColors.push(...(themeFile.tokenColors as unknown[]));
  } else if (typeof themeFile.tokenColors === "string") {
    // A string names a sibling plist that holds the token colors.
    const plistFileUri = resolveSiblingFile(fileUri, themeFile.tokenColors);
    throw new Error(`${plistFileUri.fsPath} is a TextMate plist theme, which is not supported.`);
  } else if (themeFile.tokenColors !== undefined) {
    throw new Error(`${fileUri.fsPath} has a tokenColors that is neither an array of rules nor a path to a theme file.`);
  }

  if (themeFile.semanticTokenColors && typeof themeFile.semanticTokenColors === "object") {
    Object.assign(resolvedTheme.semanticTokenColors, themeFile.semanticTokenColors);
  }

  resolvedTheme.semanticHighlighting ||= themeFile.semanticHighlighting === true;
}

function applyColors(themeFileColors: unknown, resolvedTheme: ColorThemeDocument, fileUri: vscode.Uri): void {
  if (themeFileColors === undefined) return;

  if (typeof themeFileColors !== "object" || themeFileColors === null) {
    throw new Error(`${fileUri.fsPath} has a colors that is not an object.`);
  }

  for (const [colorId, colorValue] of Object.entries(themeFileColors)) {
    if (typeof colorValue !== "string") continue;

    // The literal string "default" deletes a color that an included theme set.
    if (colorValue === "default") {
      delete resolvedTheme.colors[colorId];
      continue;
    }

    resolvedTheme.colors[colorId] = colorValue;
  }
}

// Comments and trailing commas are allowed, the way VS Code reads these. A file with syntax errors is rejected, because
// what the parser recovers is missing entries.
async function readThemeFile(fileUri: vscode.Uri): Promise<ThemeFileContents> {
  const fileContents = await vscode.workspace.fs.readFile(fileUri);
  const fileText = new TextDecoder().decode(fileContents);

  const parseErrors: jsoncParser.ParseError[] = [];
  const parsedThemeFile: unknown = jsoncParser.parse(fileText, parseErrors, { allowTrailingComma: true });

  if (parseErrors.length > 0) {
    const firstError = parseErrors[0];
    const errorName = jsoncParser.printParseErrorCode(firstError.error);
    throw new Error(`${fileUri.fsPath} is not valid JSON. ${errorName} at offset ${firstError.offset}.`);
  }

  if (typeof parsedThemeFile !== "object" || parsedThemeFile === null || Array.isArray(parsedThemeFile)) {
    throw new Error(`${fileUri.fsPath} does not hold a theme object.`);
  }

  return parsedThemeFile;
}

function resolveSiblingFile(fileUri: vscode.Uri, relativePath: string): vscode.Uri {
  return vscode.Uri.joinPath(fileUri, "..", relativePath);
}

function isJsonThemeFile(fileUri: vscode.Uri): boolean {
  return posixPath.extname(fileUri.path) === ".json";
}
