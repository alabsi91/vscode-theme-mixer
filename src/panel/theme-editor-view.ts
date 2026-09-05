import { randomUUID } from "node:crypto";

import * as vscode from "vscode";

import { getErrorMessage } from "../theme/generated-theme-file.ts";

import type {
  EditorState,
  ExtensionToWebviewMessage,
  TokenInspectionView,
  WebviewToExtensionMessage,
} from "./webview-protocol.ts";

export const THEME_EDITOR_VIEW_ID = "themeEditor.panel";

const WEBVIEW_ASSETS_DIRECTORY = "lib/webview";

// A wrong name loads as a blank panel with only a 404 in the webview devtools.
const WEBVIEW_SCRIPT_FILE_NAMES = ["main.mjs", "main.js"];

export interface ThemeEditorViewHost {
  getEditorState(): Promise<EditorState>;

  /** The view refreshes afterwards, and shows a throw as an error message. */
  handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void>;
}

export class ThemeEditorViewProvider implements vscode.WebviewViewProvider {
  private readonly extensionUri: vscode.Uri;
  private readonly host: ThemeEditorViewHost;

  // Unchecking the view in the sidebar context menu disposes it. Everything posted after that is lost.
  private view: vscode.WebviewView | null = null;

  constructor(extensionUri: vscode.Uri, host: ThemeEditorViewHost) {
    this.extensionUri = extensionUri;
    this.host = host;
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.getWebviewAssetsUri()],
    };

    webviewView.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
      void this.receiveMessage(message);
    });

    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = null;
      }
    });

    // A hidden view drops every message posted to it, without an error.
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.sendState();
      }
    });

    webviewView.webview.html = await this.createPageHtml(webviewView.webview);
  }

  // Failures reach the panel through the state message. When that one cannot be built, the panel stays empty and silent.
  async sendState(): Promise<void> {
    if (!this.view?.visible) return;

    try {
      const state = await this.host.getEditorState();
      await this.postMessage({ kind: "state", state });
    } catch (error) {
      void vscode.window.showErrorMessage(`Theme Editor: the panel could not be filled in. ${getErrorMessage(error)}`);
    }
  }

  async showTokenInspection(inspection: TokenInspectionView | null): Promise<void> {
    await this.postMessage({ kind: "tokenInspection", inspection });
  }

  private async receiveMessage(message: WebviewToExtensionMessage): Promise<void> {
    try {
      if (message.kind !== "ready") {
        await this.host.handleWebviewMessage(message);
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Theme Editor: ${getErrorMessage(error)}`);
    }

    await this.sendState();
  }

  private async postMessage(message: ExtensionToWebviewMessage): Promise<void> {
    await this.view?.webview.postMessage(message);
  }

  private getWebviewAssetsUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, WEBVIEW_ASSETS_DIRECTORY);
  }

  private async findWebviewScriptUri(): Promise<vscode.Uri> {
    const assetsUri = this.getWebviewAssetsUri();

    for (const scriptFileName of WEBVIEW_SCRIPT_FILE_NAMES) {
      const scriptUri = vscode.Uri.joinPath(assetsUri, scriptFileName);

      try {
        await vscode.workspace.fs.stat(scriptUri);
      } catch {
        continue;
      }

      return scriptUri;
    }

    const searchedNames = WEBVIEW_SCRIPT_FILE_NAMES.join(" or ");
    throw new Error(`The theme editor webview script is missing. Looked for ${searchedNames} in ${assetsUri.fsPath}.`);
  }

  private async createPageHtml(webview: vscode.Webview): Promise<string> {
    const assetsUri = this.getWebviewAssetsUri();
    const scriptUri = webview.asWebviewUri(await this.findWebviewScriptUri());
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsUri, "style.css"));
    const syntaxPanelStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(assetsUri, "syntax-panel.css"));

    const nonce = randomUUID();

    const contentSecurityPolicy = ["default-src 'none'", `style-src ${webview.cspSource}`, `script-src 'nonce-${nonce}'`].join(
      "; "
    );

    return /*html*/ `
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <link rel="stylesheet" href="${styleUri.toString()}" />
          <link rel="stylesheet" href="${syntaxPanelStyleUri.toString()}" />
          <title>Theme Editor</title>
        </head>
        <body>
          <div class="save-bar" id="saveRow" hidden>
            <span class="save-bar-text">Unsaved changes</span>
            <button type="button" class="save-bar-primary" id="saveThemeButton">Save</button>
            <button type="button" id="discardChangesButton">Discard</button>
          </div>

          <div class="save-bar notice-bar" id="themeNotShowingBar" hidden>
            <span class="save-bar-text">Your window is on another theme, so edits will not show.</span>
            <button type="button" class="save-bar-primary" id="showEditorThemeButton">Show this theme</button>
          </div>

          <p class="apply-failure" id="applyFailure" hidden></p>

          <section class="panel-section">
            <span class="section-header">Theme</span>
            <div class="base-switch" id="baseSwitch">
              <button type="button" class="base-option" data-base="dark">Dark</button>
              <button type="button" class="base-option" data-base="light">Light</button>
            </div>
            <div class="theme-row">
              <select id="savedThemeSelect" title="The theme you are editing"></select>
              <button type="button" id="createThemeButton" title="Start a new empty theme">New</button>
            </div>
            <div class="button-row">
              <button type="button" id="renameThemeButton">Rename</button>
              <button type="button" id="duplicateThemeButton">Duplicate</button>
              <button type="button" id="deleteThemeButton">Delete</button>
            </div>
            <div class="name-row" id="themeNameRow" hidden>
              <input type="text" id="themeNameInput" placeholder="Theme name" />
              <button type="button" id="themeNameConfirmButton">OK</button>
              <button type="button" id="themeNameCancelButton">Cancel</button>
            </div>
          </section>

          <section class="panel-section">
            <span class="section-header">Export</span>
            <div class="button-row">
              <button type="button" id="exportThemeButton" title="A standalone theme extension, ready to install or publish">
                As extension&hellip;
              </button>
              <button type="button" id="exportThemeJsonButton" title="One plain theme file, the format every VS Code theme uses">
                As JSON file&hellip;
              </button>
              <button type="button" id="exportThemeVsixButton" title="An installable package, the same thing vsce builds">
                As .vsix&hellip;
              </button>
            </div>
            <button
              type="button"
              class="wide-button"
              id="installThemeButton"
              title="Packages the theme and installs it into this VS Code as an extension of its own"
            >
              Install into VS Code&hellip;
            </button>
          </section>

          <section class="panel-section">
            <span class="section-header">Sync</span>
            <p class="sync-status" id="syncStatus"></p>
            <div class="button-row">
              <button type="button" id="enableSyncButton" title="Keep your saved themes in a secret gist on your GitHub account">
                Sync with GitHub&hellip;
              </button>
              <button type="button" id="signInButton" hidden>Sign in</button>
              <button type="button" id="syncNowButton" hidden>Sync now</button>
              <button type="button" id="disableSyncButton" hidden>Stop syncing</button>
            </div>
          </section>

          <details class="panel-section" id="mixSection">
            <summary class="section-header">Borrow from other themes</summary>
            <div class="take-row take-row-whole" id="takeWholeThemeTarget">
              <div class="take-row-text">
                <span class="take-row-name">Whole theme</span>
                <span class="taken-from" id="wholeThemeTakenFrom" hidden></span>
              </div>
              <button type="button" class="take-pick" id="importWholeThemeButton">Choose&hellip;</button>
            </div>
            <div class="take-row-list" id="takeCategoryList"></div>
          </details>

          <details class="panel-section" id="adjustSection">
            <summary class="section-header">Adjust colors</summary>
            <div class="adjust-row-list" id="adjustWholeThemeRow"></div>
            <div class="adjust-row-list" id="adjustCategoryList"></div>
          </details>

          <details class="panel-section colors-section" id="colorsSection">
            <summary class="section-header">Colors</summary>
            <input type="search" id="searchInput" placeholder="Search colors" />
            <div class="accordion-list">
              <div id="syntaxPanel"></div>
              <div id="categoryList"></div>
            </div>
          </details>

          <script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>
        </body>
      </html>
    `;
  }
}

export function registerThemeEditorView(context: vscode.ExtensionContext, host: ThemeEditorViewHost): ThemeEditorViewProvider {
  const provider = new ThemeEditorViewProvider(context.extensionUri, host);

  context.subscriptions.push(vscode.window.registerWebviewViewProvider(THEME_EDITOR_VIEW_ID, provider));

  return provider;
}
