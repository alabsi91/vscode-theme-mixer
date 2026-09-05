import os from "node:os";

import { strToU8, zipSync } from "fflate";
import * as vscode from "vscode";

import { showTheme } from "./apply-theme.ts";

import type { ColorThemeDocument, ThemeBaseKind } from "./generated-theme-file.ts";

const UI_THEME_BY_BASE: Record<ThemeBaseKind, string> = {
  dark: "vs-dark",
  light: "vs",
};

const EXTENSION_VERSION = "0.0.1";

const VSCODE_ENGINE_RANGE = "^1.100.0";

const ICON_PATH = "icons/icon.png";

interface ThemeExtensionFiles {
  extensionName: string;
  displayName: string;
  publisher: string;
  description: string;
  version: string;
  contentsByPath: Record<string, Uint8Array>;
}

type CreateVersion = (extensionName: string) => Promise<string>;

/** @param extensionUri This extension's own root, where the icon to copy lives. */
export async function exportThemeAsExtension(
  theme: ColorThemeDocument,
  base: ThemeBaseKind,
  extensionUri: vscode.Uri
): Promise<void> {
  const extensionFiles = await askForExtensionFiles(theme, base, extensionUri, () => Promise.resolve(EXTENSION_VERSION));
  if (!extensionFiles) return;

  const parentDirectoryUri = await askForParentDirectory();
  if (!parentDirectoryUri) return;

  const exportedExtensionUri = vscode.Uri.joinPath(parentDirectoryUri, extensionFiles.extensionName);

  for (const [relativePath, contents] of Object.entries(extensionFiles.contentsByPath)) {
    const pathSegments = relativePath.split("/");
    const directorySegments = pathSegments.slice(0, -1);

    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(exportedExtensionUri, ...directorySegments));
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(exportedExtensionUri, ...pathSegments), contents);
  }

  await offerToOpenFolder(exportedExtensionUri);
}

/** The same archive `vsce package` builds. */
export async function exportThemeAsVsix(theme: ColorThemeDocument, base: ThemeBaseKind, extensionUri: vscode.Uri): Promise<void> {
  const extensionFiles = await askForExtensionFiles(theme, base, extensionUri, () => Promise.resolve(EXTENSION_VERSION));
  if (!extensionFiles) return;

  const fileName = `${extensionFiles.extensionName}-${extensionFiles.version}.vsix`;

  const targetUri = await vscode.window.showSaveDialog({
    title: "Save theme as .vsix",
    defaultUri: vscode.Uri.joinPath(getDefaultExportDirectory(), fileName),
    filters: { "VS Code extension": ["vsix"] },
  });

  if (!targetUri) return;

  await vscode.workspace.fs.writeFile(targetUri, createVsixArchive(extensionFiles));
  await offerToReveal(targetUri, `Theme packaged to ${targetUri.fsPath}. Install it with "Extensions: Install from VSIX".`);
}

const INSTALL_VERSIONS_STATE_KEY = "installedThemeVersions";

/** Each install bumps the patch version, or VS Code refuses the reinstall. */
export async function installThemeAsExtension(
  theme: ColorThemeDocument,
  base: ThemeBaseKind,
  context: vscode.ExtensionContext
): Promise<void> {
  const createNextVersion: CreateVersion = extensionName => bumpInstallVersion(context, extensionName);

  const extensionFiles = await askForExtensionFiles(theme, base, context.extensionUri, createNextVersion);
  if (!extensionFiles) return;

  // The install command only reads a `file:` Uri. globalStorageUri can carry `vscode-userdata:`, which it refuses.
  const installsUri = vscode.Uri.joinPath(vscode.Uri.file(context.globalStorageUri.fsPath), "installs");
  await vscode.workspace.fs.createDirectory(installsUri);

  const vsixUri = vscode.Uri.joinPath(installsUri, `${extensionFiles.extensionName}-${extensionFiles.version}.vsix`);
  await vscode.workspace.fs.writeFile(vsixUri, createVsixArchive(extensionFiles));

  await vscode.commands.executeCommand("workbench.extensions.installExtension", vsixUri);

  const useAction = "Use it now";
  const installedId = `${extensionFiles.publisher}.${extensionFiles.extensionName} ${extensionFiles.version}`;
  const chosenAction = await vscode.window.showInformationMessage(
    `"${extensionFiles.displayName}" is installed as ${installedId}.`,
    useAction
  );

  if (chosenAction === useAction) {
    const showResult = await showTheme(extensionFiles.extensionName);

    if (!showResult.isApplied) {
      void vscode.window.showWarningMessage(`Theme Mixer: ${showResult.message}`);
    }
  }
}

async function bumpInstallVersion(context: vscode.ExtensionContext, extensionName: string): Promise<string> {
  const patchByExtensionName = context.globalState.get<Record<string, number>>(INSTALL_VERSIONS_STATE_KEY, {});
  const patch = (patchByExtensionName[extensionName] ?? 0) + 1;

  await context.globalState.update(INSTALL_VERSIONS_STATE_KEY, { ...patchByExtensionName, [extensionName]: patch });

  return `0.0.${patch}`;
}

export async function exportThemeAsJsonFile(theme: ColorThemeDocument): Promise<void> {
  const fileName = `${createExtensionName(theme.name)}-color-theme.json`;

  const targetUri = await vscode.window.showSaveDialog({
    title: "Save theme as JSON",
    defaultUri: vscode.Uri.joinPath(getDefaultExportDirectory(), fileName),
    filters: { "VS Code color theme": ["json"] },
  });

  if (!targetUri) return;

  await vscode.workspace.fs.writeFile(targetUri, strToU8(toJsonText(theme)));
  await offerToReveal(targetUri, `Theme saved to ${targetUri.fsPath}.`);
}

async function askForExtensionFiles(
  theme: ColorThemeDocument,
  base: ThemeBaseKind,
  extensionUri: vscode.Uri,
  createVersion: CreateVersion
): Promise<ThemeExtensionFiles | undefined> {
  const displayName = await askForDisplayName(theme.name);
  if (!displayName) {
    return undefined;
  }

  const publisher = await askForPublisher();
  if (!publisher) {
    return undefined;
  }

  const extensionName = createExtensionName(displayName);
  const version = await createVersion(extensionName);
  const iconBytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, ICON_PATH));

  return createThemeExtensionFiles(theme, base, displayName, publisher, extensionName, version, iconBytes);
}

function askForDisplayName(currentName: string): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: "Export theme",
    prompt: "The name people will see in the theme picker",
    value: currentName,
    validateInput: value => (value.trim() === "" ? "The theme needs a name." : undefined),
  });
}

function askForPublisher(): Thenable<string | undefined> {
  return vscode.window.showInputBox({
    title: "Export theme",
    prompt: "Your marketplace publisher id. Anything works if you are only installing it yourself.",
    placeHolder: "publisher-id",
    // The rule vsce applies. Anything else fails there.
    validateInput: value => (/^[a-z0-9][a-z0-9-]*$/i.test(value) ? undefined : "Letters, digits and hyphens only."),
  });
}

async function askForParentDirectory(): Promise<vscode.Uri | undefined> {
  const chosenDirectories = await vscode.window.showOpenDialog({
    title: "Where should the theme extension go?",
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Export here",
  });

  return chosenDirectories?.[0];
}

function getDefaultExportDirectory(): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

  return workspaceFolder?.uri ?? vscode.Uri.file(os.homedir());
}

function createThemeExtensionFiles(
  theme: ColorThemeDocument,
  base: ThemeBaseKind,
  displayName: string,
  publisher: string,
  extensionName: string,
  version: string,
  iconBytes: Uint8Array
): ThemeExtensionFiles {
  const description = `${displayName}, a color theme for VS Code.`;
  const themeFileName = `${extensionName}-color-theme.json`;

  const manifest = {
    name: extensionName,
    displayName,
    description,
    version,
    publisher,
    icon: ICON_PATH,
    engines: { vscode: VSCODE_ENGINE_RANGE },
    categories: ["Themes"],
    // Without an id the display name is the settings id. "Monokai" would select whichever theme registered it first.
    contributes: {
      themes: [{ id: extensionName, label: displayName, uiTheme: UI_THEME_BY_BASE[base], path: `./themes/${themeFileName}` }],
    },
  };

  const exportedTheme: ColorThemeDocument = { ...theme, name: displayName };

  return {
    extensionName,
    displayName,
    publisher,
    description,
    version,
    contentsByPath: {
      "package.json": strToU8(toJsonText(manifest)),
      [`themes/${themeFileName}`]: strToU8(toJsonText(exportedTheme)),
      "README.md": strToU8(createReadme(displayName)),
      [ICON_PATH]: iconBytes,
    },
  };
}

function createExtensionName(displayName: string): string {
  const asciiName = displayName
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");

  return asciiName === "" ? "color-theme" : asciiName;
}

function createReadme(displayName: string): string {
  return [
    `# ${displayName}`,
    "",
    "A color theme for VS Code.",
    "",
    "## Installing it yourself",
    "",
    "```bash",
    "npx @vscode/vsce package",
    "code --install-extension *.vsix",
    "```",
    "",
    "## Publishing it",
    "",
    "```bash",
    "npx @vscode/vsce publish",
    "```",
    "",
    "Publishing needs a marketplace publisher and an access token. See",
    "https://code.visualstudio.com/api/working-with-extensions/publishing-extension.",
    "",
  ].join("\n");
}

function createVsixArchive(extensionFiles: ThemeExtensionFiles): Uint8Array {
  const archiveEntries: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(createContentTypesXml()),
    "extension.vsixmanifest": strToU8(createVsixManifestXml(extensionFiles)),
  };

  for (const [relativePath, contents] of Object.entries(extensionFiles.contentsByPath)) {
    archiveEntries[`extension/${relativePath}`] = contents;
  }

  return zipSync(archiveEntries, { level: 9 });
}

function createContentTypesXml(): string {
  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`,
    `  <Default Extension=".json" ContentType="application/json"/>`,
    `  <Default Extension=".vsixmanifest" ContentType="text/xml"/>`,
    `  <Default Extension=".md" ContentType="text/markdown"/>`,
    `  <Default Extension=".png" ContentType="image/png"/>`,
    `</Types>`,
    "",
  ].join("\n");
}

function createVsixManifestXml(extensionFiles: ThemeExtensionFiles): string {
  const { extensionName, displayName, publisher, description, version } = extensionFiles;

  return [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">`,
    `  <Metadata>`,
    `    <Identity Language="en-US" Id="${escapeXml(extensionName)}" Version="${escapeXml(version)}" Publisher="${escapeXml(publisher)}" />`,
    `    <DisplayName>${escapeXml(displayName)}</DisplayName>`,
    `    <Description xml:space="preserve">${escapeXml(description)}</Description>`,
    `    <Tags>theme,color-theme</Tags>`,
    `    <Categories>Themes</Categories>`,
    `    <GalleryFlags>Public</GalleryFlags>`,
    `    <Properties>`,
    `      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${VSCODE_ENGINE_RANGE}" />`,
    `      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />`,
    `      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />`,
    `      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui,workspace" />`,
    `      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />`,
    `      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />`,
    `      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free"/>`,
    `    </Properties>`,
    `    <Icon>extension/${ICON_PATH}</Icon>`,
    `  </Metadata>`,
    `  <Installation>`,
    `    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>`,
    `  </Installation>`,
    `  <Dependencies/>`,
    `  <Assets>`,
    `    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />`,
    `    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />`,
    `    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${ICON_PATH}" Addressable="true" />`,
    `  </Assets>`,
    `</PackageManifest>`,
    "",
  ].join("\n");
}

function escapeXml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function toJsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function offerToReveal(fileUri: vscode.Uri, message: string): Promise<void> {
  const revealAction = "Reveal in Finder";
  const chosenAction = await vscode.window.showInformationMessage(message, revealAction);

  if (chosenAction === revealAction) {
    await vscode.commands.executeCommand("revealFileInOS", fileUri);
  }
}

async function offerToOpenFolder(exportedExtensionUri: vscode.Uri): Promise<void> {
  const openAction = "Open folder";
  const revealAction = "Reveal in Finder";

  const chosenAction = await vscode.window.showInformationMessage(
    `Theme exported to ${exportedExtensionUri.fsPath}. Run "npx @vscode/vsce package" in it to build a .vsix.`,
    openAction,
    revealAction
  );

  if (chosenAction === openAction) {
    await vscode.commands.executeCommand("vscode.openFolder", exportedExtensionUri, { forceNewWindow: true });
    return;
  }

  if (chosenAction === revealAction) {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.joinPath(exportedExtensionUri, "package.json"));
  }
}
