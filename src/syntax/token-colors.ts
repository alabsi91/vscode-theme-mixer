import * as vscode from "vscode";

import { getEditingBase, openEditableTheme } from "../theme/working-theme.ts";
import { TextMateTokenizer, getSemanticTokenAtPosition } from "./textmate-tokenizer.ts";
import { createTokenColorMatcher } from "./token-color-matcher.ts";

import type { ThemeEditorViewProvider } from "../panel/theme-editor-view.ts";
import type { TokenColorRuleView } from "../panel/webview-protocol.ts";
import type { ColorThemeDocument } from "../theme/generated-theme-file.ts";

const TOKEN_INSPECTION_DEBOUNCE_MILLISECONDS = 100;

interface TokenColorEntry {
  name?: string;
  scope?: string | string[];
  settings?: { foreground?: string; fontStyle?: string };
}

export interface TokenColorRuleChanges {
  /** Null clears the property, which lets the rule inherit again. */
  foreground?: string | null;
  fontStyle?: string | null;
}

export function setTokenColorRule(theme: ColorThemeDocument, ruleIndex: number, changes: TokenColorRuleChanges): void {
  const rule = theme.tokenColors[ruleIndex] as TokenColorEntry | undefined;
  if (!rule) return;

  rule.settings ??= {};

  if (changes.foreground !== undefined) {
    setRuleSetting(rule.settings, "foreground", changes.foreground);
  }

  if (changes.fontStyle !== undefined) {
    setRuleSetting(rule.settings, "fontStyle", changes.fontStyle);
  }
}

/** A later rule beats an earlier one of the same specificity. Appending is what makes the new rule win. */
export function appendTokenColorRule(theme: ColorThemeDocument, scope: string, foreground: string): void {
  theme.tokenColors.push({
    name: `Theme Editor: ${scope}`,
    scope,
    settings: { foreground },
  } satisfies TokenColorEntry);
}

export function deleteTokenColorRule(theme: ColorThemeDocument, ruleIndex: number): void {
  theme.tokenColors.splice(ruleIndex, 1);
}

export function createTokenColorRuleViews(theme: ColorThemeDocument): TokenColorRuleView[] {
  return theme.tokenColors.map((entry, index): TokenColorRuleView => {
    const rule = entry as TokenColorEntry;
    const scope = rule.scope ?? [];

    return {
      index,
      name: rule.name ?? "",
      scopes: Array.isArray(scope) ? scope : scope.split(",").map(singleScope => singleScope.trim()),
      foreground: rule.settings?.foreground ?? null,
      fontStyle: rule.settings?.fontStyle ?? null,
    };
  });
}

function setRuleSetting(settings: Record<string, string | undefined>, settingName: string, value: string | null): void {
  if (value === null) {
    delete settings[settingName];
    return;
  }

  settings[settingName] = value;
}

// Built the first time the user follows the cursor. The regex engine is not worth loading before that.
let textMateTokenizer: TextMateTokenizer | undefined;

let tokenInspectionListener: vscode.Disposable | undefined;

let pendingInspectionTimer: ReturnType<typeof setTimeout> | undefined;

// Bumped when inspection is turned on or off. A report from before the switch is thrown away.
let tokenInspectionGeneration = 0;

export function isTokenInspectionEnabled(): boolean {
  return tokenInspectionListener !== undefined;
}

// Selection changes fire on every keystroke, and tokenizing walks the document from its first line. Hence the debounce.
export function setTokenInspectionEnabled(
  context: vscode.ExtensionContext,
  isEnabled: boolean,
  getThemeEditorView: () => ThemeEditorViewProvider
): void {
  tokenInspectionListener?.dispose();
  tokenInspectionListener = undefined;

  // A pending report must not land after inspection was turned off.
  clearTimeout(pendingInspectionTimer);
  pendingInspectionTimer = undefined;
  tokenInspectionGeneration++;

  if (!isEnabled) {
    void getThemeEditorView().showTokenInspection(null);
    return;
  }

  textMateTokenizer ??= new TextMateTokenizer(context.extensionUri);

  const generation = tokenInspectionGeneration;

  tokenInspectionListener = vscode.window.onDidChangeTextEditorSelection(event => {
    clearTimeout(pendingInspectionTimer);
    pendingInspectionTimer = setTimeout(() => {
      void reportTokenInspection(context, event.textEditor, getThemeEditorView, generation);
    }, TOKEN_INSPECTION_DEBOUNCE_MILLISECONDS);
  });

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor) {
    void reportTokenInspection(context, activeEditor, getThemeEditorView, generation);
  }
}

async function reportTokenInspection(
  context: vscode.ExtensionContext,
  editor: vscode.TextEditor,
  getThemeEditorView: () => ThemeEditorViewProvider,
  generation: number
): Promise<void> {
  if (!textMateTokenizer) return;

  try {
    const position = editor.selection.active;
    const token = await textMateTokenizer.getTokenAtPosition(editor.document, position);

    if (generation !== tokenInspectionGeneration) return;

    if (!token) {
      await getThemeEditorView().showTokenInspection(null);
      return;
    }

    const base = getEditingBase(context);
    const { theme } = await openEditableTheme(context, base);

    const matcher = createTokenColorMatcher(theme.tokenColors, theme.colors["editor.foreground"] ?? null);
    const match = matcher.matchScopeStack(token.scopes);

    const semanticToken = await getSemanticTokenAtPosition(editor.document, position);

    if (generation !== tokenInspectionGeneration) return;

    await getThemeEditorView().showTokenInspection({
      text: token.text,
      scopes: token.scopes,
      winningRuleIndex: match.foregroundRuleIndex,
      foreground: match.foreground,
      semanticTokenType: semanticToken?.tokenType ?? null,
    });
  } catch {
    // A grammar that will not load must never break the panel.
    if (generation === tokenInspectionGeneration) {
      await getThemeEditorView().showTokenInspection(null);
    }
  }
}
