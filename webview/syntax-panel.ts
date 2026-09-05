import { HEX_COLOR_PATTERN } from "../src/theme/hex-color.ts";
import { createThrottledSender, getColorWithCurrentAlpha, getSwatchValue } from "./color-input.ts";

import type { TokenColorRuleView, TokenInspectionView } from "../src/panel/webview-protocol.ts";

/** A `details` element with a name closes its siblings when it opens. */
export const ACCORDION_GROUP_NAME = "themeEditorSection";

export interface SyntaxPanelCallbacks {
  changeTokenColorRule(ruleIndex: number, ruleChanges: { foreground?: string | null; fontStyle?: string | null }): void;
  deleteTokenColorRule(ruleIndex: number): void;
  createTokenColorRuleForScope(scope: string, foreground: string): void;
  changeTokenInspectionEnabled(isEnabled: boolean): void;
}

// The first match wins. Specific entries come before general ones. Anything missing falls back to the raw scope.
const PLAIN_ENGLISH_SCOPE_LABELS: [scope: string, label: string][] = [
  ["entity.name.function", "function name"],
  ["entity.name.class", "class name"],
  ["entity.name.type", "type name"],
  ["entity.name.namespace", "namespace"],
  ["entity.name.tag", "tag"],
  ["entity.other.attribute-name", "attribute"],
  ["entity.name", "name"],
  ["support.function", "built-in function"],
  ["support.class", "built-in class"],
  ["support.type", "built-in type"],
  ["support.variable", "built-in variable"],
  ["variable.parameter", "parameter"],
  ["variable.other.property", "property"],
  ["variable.other.member", "property"],
  ["variable.language", "keyword"],
  ["variable", "variable"],
  ["meta.object-literal.key", "property"],
  ["string.regexp", "regular expression"],
  ["string", "string"],
  ["comment", "comment"],
  ["constant.numeric", "number"],
  ["constant.character.escape", "escape sequence"],
  ["constant.language", "keyword"],
  ["constant", "constant"],
  ["keyword.operator", "operator"],
  ["keyword", "keyword"],
  ["storage.type", "type"],
  ["storage", "keyword"],
  ["punctuation", "punctuation"],
  ["invalid", "error"],
  ["markup.heading", "heading"],
  ["markup.bold", "bold text"],
  ["markup.italic", "italic text"],
  ["markup.underline.link", "link"],
];

const FONT_STYLE_NAMES = ["bold", "italic", "underline"] as const;

type FontStyleName = (typeof FONT_STYLE_NAMES)[number];

const FALLBACK_NEW_RULE_COLOR = "#ff8800";

interface TokenColorRuleRow {
  ruleIndex: number;
  scopes: string[];
  rowElement: HTMLElement;
  colorInput: HTMLInputElement;
  fontStyleButtonByName: Map<FontStyleName, HTMLButtonElement>;
  searchText: string;
}

let panelCallbacks: SyntaxPanelCallbacks | null = null;

let filterInput: HTMLInputElement;
let ruleListElement: HTMLElement;
let ruleCountElement: HTMLElement;

let followCursorCheckbox: HTMLInputElement;
let inspectorBodyElement: HTMLElement;
let inspectorTokenElement: HTMLElement;
let inspectorVerdictElement: HTMLElement;
let inspectorSemanticWarningElement: HTMLElement;
let inspectorScopeListElement: HTMLElement;
let inspectorCreateRuleRow: HTMLElement;
let inspectorCreateRuleColorInput: HTMLInputElement;
let inspectorCreateRuleButton: HTMLButtonElement;

const ruleRows: TokenColorRuleRow[] = [];
const ruleRowByRuleIndex = new Map<number, TokenColorRuleRow>();

const fontStyleNamesByRuleIndex = new Map<number, Set<FontStyleName>>();
const rawFontStyleByRuleIndex = new Map<number, string | null>();
const foregroundByRuleIndex = new Map<number, string | null>();

// What a rule had before the buttons touched it. Turning every button off puts that back.
const fontStyleBeforeEditsByRuleIndex = new Map<number, string | null>();

const ruleColorChangeSender = createThrottledSender<number, string>((ruleIndex, foreground) => {
  panelCallbacks?.changeTokenColorRule(ruleIndex, { foreground });
});

// Rebuilding hundreds of rows on every state would fight the color picker.
let builtRuleStructure = "";

let scopeForNewRule = "";

// Deleting a rule shifts every index after it. Editing by an old index would hit the wrong rule.
let isWaitingForRuleListRebuild = false;

export function initSyntaxPanel(containerElement: HTMLElement, callbacks: SyntaxPanelCallbacks): void {
  panelCallbacks = callbacks;

  ruleRows.length = 0;
  ruleRowByRuleIndex.clear();
  builtRuleStructure = "";

  buildPanel(containerElement);
  listenForRuleEdits();
  listenForInspectorCommands();
}

export function showTokenColorRules(tokenColorRules: TokenColorRuleView[]): void {
  const ruleStructure = getRuleStructure(tokenColorRules);

  if (ruleStructure !== builtRuleStructure) {
    buildRuleRows(tokenColorRules);
    builtRuleStructure = ruleStructure;
    applyRuleFilter();
    isWaitingForRuleListRebuild = false;
  }

  for (const rule of tokenColorRules) {
    const row = ruleRowByRuleIndex.get(rule.index);
    if (row) {
      showRuleInRow(row, rule);
    }
  }

  ruleCountElement.textContent = `${tokenColorRules.length} rules`;
}

export function showTokenInspectionEnabled(isEnabled: boolean): void {
  followCursorCheckbox.checked = isEnabled;
}

export function showTokenInspection(inspection: TokenInspectionView | null): void {
  clearWinningRuleHighlight();

  if (!inspection) {
    inspectorBodyElement.hidden = true;
    scopeForNewRule = "";
    return;
  }

  inspectorBodyElement.hidden = false;

  showInspectedToken(inspection);
  showInspectionVerdict(inspection);
  showInspectionScopes(inspection.scopes);
  showCreateRuleOffer(inspection);

  if (inspection.winningRuleIndex !== null) {
    highlightWinningRule(inspection.winningRuleIndex);
  }
}

// ---------------------------------------------------------------------------------------------
// Building the panel

function buildPanel(containerElement: HTMLElement): void {
  containerElement.classList.add("syntax-panel");

  const inspectorElement = buildInspector();

  const filterRow = document.createElement("div");
  filterRow.className = "syntax-filter-row";

  filterInput = document.createElement("input");
  filterInput.type = "search";
  filterInput.className = "syntax-filter";
  filterInput.placeholder = "Filter rules";
  filterInput.autocomplete = "off";

  ruleCountElement = document.createElement("span");
  ruleCountElement.className = "syntax-rule-count";

  filterRow.append(filterInput, ruleCountElement);

  ruleListElement = document.createElement("div");
  ruleListElement.className = "syntax-rule-list";

  const sectionElement = document.createElement("details");
  sectionElement.className = "category";
  sectionElement.name = ACCORDION_GROUP_NAME;

  const summaryElement = document.createElement("summary");
  summaryElement.className = "category-summary";
  summaryElement.textContent = "Syntax Highlighting";

  sectionElement.append(summaryElement, inspectorElement, filterRow, ruleListElement);
  containerElement.replaceChildren(sectionElement);
}

function buildInspector(): HTMLElement {
  const inspectorElement = document.createElement("section");
  inspectorElement.className = "syntax-inspector";

  const followCursorLabel = document.createElement("label");
  followCursorLabel.className = "syntax-follow-cursor";
  followCursorLabel.title = "Shows which rule colors the word under your cursor in the editor";

  followCursorCheckbox = document.createElement("input");
  followCursorCheckbox.type = "checkbox";

  const followCursorText = document.createElement("span");
  followCursorText.textContent = "Follow my cursor";

  followCursorLabel.append(followCursorCheckbox, followCursorText);

  inspectorBodyElement = document.createElement("div");
  inspectorBodyElement.className = "syntax-inspector-body";
  inspectorBodyElement.hidden = true;

  inspectorTokenElement = document.createElement("div");
  inspectorTokenElement.className = "syntax-inspected-token";
  inspectorTokenElement.title = "The word under your cursor, in the color the theme gives it";

  inspectorSemanticWarningElement = document.createElement("p");
  inspectorSemanticWarningElement.className = "syntax-semantic-warning";
  inspectorSemanticWarningElement.hidden = true;

  inspectorVerdictElement = document.createElement("p");
  inspectorVerdictElement.className = "syntax-inspector-verdict";

  inspectorScopeListElement = document.createElement("div");
  inspectorScopeListElement.className = "syntax-scope";

  inspectorCreateRuleRow = document.createElement("div");
  inspectorCreateRuleRow.className = "syntax-create-rule-row";
  inspectorCreateRuleRow.hidden = true;

  inspectorCreateRuleColorInput = document.createElement("input");
  inspectorCreateRuleColorInput.type = "color";
  inspectorCreateRuleColorInput.className = "syntax-swatch";
  inspectorCreateRuleColorInput.title = "The color the new rule starts with";

  inspectorCreateRuleButton = document.createElement("button");
  inspectorCreateRuleButton.type = "button";
  inspectorCreateRuleButton.className = "syntax-create-rule-button";

  inspectorCreateRuleRow.append(inspectorCreateRuleColorInput, inspectorCreateRuleButton);

  inspectorBodyElement.append(
    inspectorTokenElement,
    inspectorSemanticWarningElement,
    inspectorVerdictElement,
    inspectorScopeListElement,
    inspectorCreateRuleRow
  );

  inspectorElement.append(followCursorLabel, inspectorBodyElement);

  return inspectorElement;
}

// ---------------------------------------------------------------------------------------------
// The rule list

function getRuleStructure(tokenColorRules: TokenColorRuleView[]): string {
  return tokenColorRules.map(rule => `${rule.index}:${rule.name}:${rule.scopes.join(" ")}`).join("|");
}

function buildRuleRows(tokenColorRules: TokenColorRuleView[]): void {
  ruleRows.length = 0;
  ruleRowByRuleIndex.clear();
  fontStyleBeforeEditsByRuleIndex.clear();

  const ruleFragment = document.createDocumentFragment();

  for (const rule of tokenColorRules) {
    const row = createRuleRow(rule);

    ruleRows.push(row);
    ruleRowByRuleIndex.set(rule.index, row);
    ruleFragment.append(row.rowElement);
  }

  ruleListElement.replaceChildren(ruleFragment);
}

function createRuleRow(rule: TokenColorRuleView): TokenColorRuleRow {
  const rowElement = document.createElement("div");
  rowElement.className = "syntax-rule";
  rowElement.dataset.ruleIndex = String(rule.index);

  const controlsElement = document.createElement("div");
  controlsElement.className = "syntax-rule-controls";

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "syntax-swatch";
  colorInput.title = "The color this rule paints";

  const labelElement = document.createElement("div");
  labelElement.className = "syntax-rule-label";
  labelElement.textContent = getRuleLabel(rule);

  const fontStyleButtonByName = new Map<FontStyleName, HTMLButtonElement>();

  const fontStyleGroup = document.createElement("div");
  fontStyleGroup.className = "syntax-font-styles";

  for (const fontStyleName of FONT_STYLE_NAMES) {
    const fontStyleButton = document.createElement("button");
    fontStyleButton.type = "button";
    fontStyleButton.className = `syntax-font-style syntax-font-style-${fontStyleName}`;
    fontStyleButton.dataset.fontStyleName = fontStyleName;
    fontStyleButton.title = fontStyleName;
    fontStyleButton.textContent = fontStyleName.charAt(0).toUpperCase();

    fontStyleButtonByName.set(fontStyleName, fontStyleButton);
    fontStyleGroup.append(fontStyleButton);
  }

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "syntax-delete-rule";
  deleteButton.title = "Delete this rule";
  deleteButton.textContent = "×";

  controlsElement.append(colorInput, labelElement, fontStyleGroup, deleteButton);

  rowElement.title = rule.scopes.join(", ");

  rowElement.append(controlsElement);

  return {
    ruleIndex: rule.index,
    scopes: rule.scopes,
    rowElement,
    colorInput,
    fontStyleButtonByName,
    searchText: `${getRuleLabel(rule)} ${rule.name} ${rule.scopes.join(" ")}`.toLowerCase(),
  };
}

function showRuleInRow(row: TokenColorRuleRow, rule: TokenColorRuleView): void {
  foregroundByRuleIndex.set(rule.index, rule.foreground);

  const swatchValue = getSwatchValue(rule.foreground);

  // A state that arrives mid drag is older than the swatch. Writing it back would snap the picker backwards.
  const hasQueuedColorEdit = ruleColorChangeSender.hasQueuedChange(rule.index);
  if (!hasQueuedColorEdit && row.colorInput.value !== swatchValue) {
    row.colorInput.value = swatchValue;
  }

  const activeFontStyleNames = parseFontStyle(rule.fontStyle);
  fontStyleNamesByRuleIndex.set(rule.index, activeFontStyleNames);
  rawFontStyleByRuleIndex.set(rule.index, rule.fontStyle);

  for (const [fontStyleName, fontStyleButton] of row.fontStyleButtonByName) {
    const isActive = activeFontStyleNames.has(fontStyleName);
    fontStyleButton.classList.toggle("is-active", isActive);
    fontStyleButton.setAttribute("aria-pressed", String(isActive));
  }
}

const MAXIMUM_LABEL_PARTS = 3;

function getRuleLabel(rule: TokenColorRuleView): string {
  if (rule.name) {
    return rule.name;
  }

  if (rule.scopes.length === 0) {
    return "Everything else";
  }

  const plainEnglishLabels = [...new Set(rule.scopes.map(scope => getPlainEnglishScopeLabel(scope)))];
  if (plainEnglishLabels.length <= MAXIMUM_LABEL_PARTS) {
    return plainEnglishLabels.join(", ");
  }

  const remainingCount = plainEnglishLabels.length - MAXIMUM_LABEL_PARTS;

  return `${plainEnglishLabels.slice(0, MAXIMUM_LABEL_PARTS).join(", ")} and ${remainingCount} more`;
}

// Only the last space-separated part decides what the rule colors.
function getPlainEnglishScopeLabel(scope: string): string {
  const ownScope = scope.trim().split(/\s+/).at(-1) ?? scope;

  for (const [labeledScope, label] of PLAIN_ENGLISH_SCOPE_LABELS) {
    if (ownScope === labeledScope || ownScope.startsWith(`${labeledScope}.`)) {
      return label;
    }
  }

  return ownScope;
}

function parseFontStyle(fontStyle: string | null): Set<FontStyleName> {
  const activeFontStyleNames = new Set<FontStyleName>();

  if (fontStyle) {
    for (const fontStyleName of FONT_STYLE_NAMES) {
      if (fontStyle.includes(fontStyleName)) {
        activeFontStyleNames.add(fontStyleName);
      }
    }
  }

  return activeFontStyleNames;
}

// ---------------------------------------------------------------------------------------------
// Editing a rule

function listenForRuleEdits(): void {
  ruleListElement.addEventListener("input", event => {
    if (isWaitingForRuleListRebuild) return;

    const target = event.target as HTMLElement;
    if (!target.classList.contains("syntax-swatch")) return;

    const ruleIndex = getRowRuleIndex(target);
    if (ruleIndex === null) return;

    const pickedValue = (target as HTMLInputElement).value;
    const foreground = getColorWithCurrentAlpha(foregroundByRuleIndex.get(ruleIndex), pickedValue);

    foregroundByRuleIndex.set(ruleIndex, foreground);
    ruleColorChangeSender.send(ruleIndex, foreground);
  });

  ruleListElement.addEventListener("click", event => {
    if (isWaitingForRuleListRebuild) return;

    const target = event.target as HTMLElement;

    const fontStyleButton = target.closest<HTMLButtonElement>(".syntax-font-style");
    if (fontStyleButton) {
      toggleFontStyle(fontStyleButton);
      return;
    }

    if (target.classList.contains("syntax-delete-rule")) {
      const ruleIndex = getRowRuleIndex(target);
      if (ruleIndex !== null) {
        deleteRule(ruleIndex);
      }
    }
  });

  filterInput.addEventListener("input", () => applyRuleFilter());
}

function deleteRule(ruleIndex: number): void {
  isWaitingForRuleListRebuild = true;

  // A queued edit is addressed by an index that the delete is about to shift.
  ruleColorChangeSender.clearQueuedChanges();

  panelCallbacks?.deleteTokenColorRule(ruleIndex);
}

function toggleFontStyle(fontStyleButton: HTMLButtonElement): void {
  const ruleIndex = getRowRuleIndex(fontStyleButton);
  if (ruleIndex === null) return;

  const toggledFontStyleName = fontStyleButton.dataset.fontStyleName as FontStyleName | undefined;
  if (!toggledFontStyleName) return;

  const activeFontStyleNames = new Set(fontStyleNamesByRuleIndex.get(ruleIndex));

  if (activeFontStyleNames.has(toggledFontStyleName)) {
    activeFontStyleNames.delete(toggledFontStyleName);
  } else {
    activeFontStyleNames.add(toggledFontStyleName);
  }

  fontStyleNamesByRuleIndex.set(ruleIndex, activeFontStyleNames);

  const rawFontStyle = rawFontStyleByRuleIndex.get(ruleIndex) ?? null;

  if (!fontStyleBeforeEditsByRuleIndex.has(ruleIndex)) {
    fontStyleBeforeEditsByRuleIndex.set(ruleIndex, rawFontStyle);
  }

  // Keep the constant's order, or the written value shuffles on every toggle.
  const orderedFontStyleNames = FONT_STYLE_NAMES.filter(fontStyleName => activeFontStyleNames.has(fontStyleName));
  const fontStyleWords = [...orderedFontStyleNames, ...getFontStyleWordsWithNoButton(rawFontStyle)];

  // A rule that never had a style goes back to inheriting one. A rule that had one gets "", which is how a theme
  // turns a style off.
  const hasFontStyleBeforeEdits = fontStyleBeforeEditsByRuleIndex.get(ruleIndex) !== null;
  const emptyFontStyle = hasFontStyleBeforeEdits ? "" : null;
  const fontStyle = fontStyleWords.length === 0 ? emptyFontStyle : fontStyleWords.join(" ");

  rawFontStyleByRuleIndex.set(ruleIndex, fontStyle);

  panelCallbacks?.changeTokenColorRule(ruleIndex, { fontStyle });
}

function getFontStyleWordsWithNoButton(rawFontStyle: string | null): string[] {
  if (!rawFontStyle) {
    return [];
  }

  const buttonFontStyleNames: readonly string[] = FONT_STYLE_NAMES;

  return rawFontStyle.split(/\s+/).filter(word => word !== "" && !buttonFontStyleNames.includes(word));
}

function getRowRuleIndex(element: HTMLElement): number | null {
  const rawRuleIndex = element.closest<HTMLElement>(".syntax-rule")?.dataset.ruleIndex;
  if (rawRuleIndex === undefined) {
    return null;
  }

  return Number(rawRuleIndex);
}

// ---------------------------------------------------------------------------------------------
// Filtering

function applyRuleFilter(): void {
  const query = filterInput.value.trim().toLowerCase();

  for (const row of ruleRows) {
    row.rowElement.hidden = query !== "" && !row.searchText.includes(query);
  }
}

// ---------------------------------------------------------------------------------------------
// The inspector

function listenForInspectorCommands(): void {
  followCursorCheckbox.addEventListener("change", () => {
    panelCallbacks?.changeTokenInspectionEnabled(followCursorCheckbox.checked);

    if (!followCursorCheckbox.checked) {
      showTokenInspection(null);
    }
  });

  inspectorCreateRuleButton.addEventListener("click", () => {
    if (!scopeForNewRule) return;

    panelCallbacks?.createTokenColorRuleForScope(scopeForNewRule, inspectorCreateRuleColorInput.value);

    // One rule per press. The offer comes back with the next inspection, when the token has no rule of its own.
    scopeForNewRule = "";
    inspectorCreateRuleRow.hidden = true;
  });
}

function showInspectedToken(inspection: TokenInspectionView): void {
  inspectorTokenElement.textContent = inspection.text;
  inspectorTokenElement.style.color = inspection.foreground ?? "inherit";
}

function showInspectionVerdict(inspection: TokenInspectionView): void {
  const hasSemanticColor = inspection.semanticTokenType !== null;

  inspectorSemanticWarningElement.hidden = !hasSemanticColor;

  if (hasSemanticColor) {
    inspectorSemanticWarningElement.textContent = `Painted by the language server as "${inspection.semanticTokenType}", not by the rule below.`;
  }

  if (inspection.winningRuleIndex === null) {
    inspectorVerdictElement.textContent = "No rule matches. Using the default color.";
    return;
  }

  const winningRow = ruleRowByRuleIndex.get(inspection.winningRuleIndex);
  const winningRuleLabel = winningRow?.rowElement.querySelector(".syntax-rule-label")?.textContent ?? "a rule";

  inspectorVerdictElement.textContent = winningRuleLabel;
}

function showInspectionScopes(scopes: string[]): void {
  const innermostScope = scopes.at(-1) ?? "";

  inspectorScopeListElement.textContent = innermostScope;
  inspectorScopeListElement.title = scopes.join("\n");
  inspectorScopeListElement.hidden = innermostScope === "";
}

// Offered even when a rule already matches. That rule usually covers many scopes, and a rule of the token's own is the
// only way to change this token alone.
function showCreateRuleOffer(inspection: TokenInspectionView): void {
  const mostSpecificScope = inspection.scopes.at(-1) ?? "";
  const hasOwnRule = ruleRows.some(row => row.scopes.includes(mostSpecificScope));
  const canCreateRule = mostSpecificScope !== "" && !hasOwnRule;

  scopeForNewRule = canCreateRule ? mostSpecificScope : "";
  inspectorCreateRuleRow.hidden = !canCreateRule;

  if (canCreateRule) {
    const hasReadableTokenColor = inspection.foreground !== null && HEX_COLOR_PATTERN.test(inspection.foreground);

    inspectorCreateRuleButton.textContent = "Color this token only";
    inspectorCreateRuleButton.title = `Adds a rule for ${mostSpecificScope} with this color. Other tokens keep theirs.`;
    inspectorCreateRuleColorInput.value = hasReadableTokenColor ? getSwatchValue(inspection.foreground) : FALLBACK_NEW_RULE_COLOR;
  }
}

function clearWinningRuleHighlight(): void {
  for (const row of ruleRows) {
    row.rowElement.classList.remove("is-winning-rule");
  }
}

function highlightWinningRule(winningRuleIndex: number): void {
  const winningRow = ruleRowByRuleIndex.get(winningRuleIndex);
  if (!winningRow) return;

  winningRow.rowElement.classList.add("is-winning-rule");

  if (!winningRow.rowElement.hidden) {
    winningRow.rowElement.scrollIntoView({ block: "nearest" });
  }
}
