import { WHOLE_THEME_TAKE_TARGET_ID } from "../src/panel/webview-protocol.ts";
import { ADJUSTMENT_LIMITS } from "../src/theme/adjust-colors.ts";
import { HEX_COLOR_PATTERN, expandShorthandHexColor } from "../src/theme/hex-color.ts";
import { createThrottledSender, getColorWithCurrentAlpha, getSwatchValue } from "./color-input.ts";
import {
  ACCORDION_GROUP_NAME,
  initSyntaxPanel,
  showTokenColorRules,
  showTokenInspection,
  showTokenInspectionEnabled,
} from "./syntax-panel.ts";

import type {
  ColorCategoryView,
  ColorKeyView,
  EditorState,
  ExtensionToWebviewMessage,
  SavedThemeView,
  SyncState,
  WebviewToExtensionMessage,
} from "../src/panel/webview-protocol.ts";
import type { ColorAdjustment } from "../src/theme/adjust-colors.ts";
import type { ThemeBaseKind } from "../src/theme/generated-theme-file.ts";

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToExtensionMessage): void;
  getState(): PersistedViewState | undefined;
  setState(state: PersistedViewState): void;
};

/** What survives the view being collapsed and reopened. */
interface PersistedViewState {
  searchText: string;
  expandedCategoryIds: string[];
}

interface ColorKeyRow {
  rowElement: HTMLElement;
  colorInput: HTMLInputElement;
  adjustedSwatch: HTMLElement;
  hexInput: HTMLInputElement;
  clearButton: HTMLButtonElement;
  searchText: string;
}

interface CategorySection {
  categoryId: string;
  detailsElement: HTMLDetailsElement;
  colorKeyRows: ColorKeyRow[];
}

interface AdjustSlider {
  property: keyof ColorAdjustment;
  labelElement: HTMLLabelElement;
  rangeInput: HTMLInputElement;
  valueElement: HTMLElement;
}

interface AdjustRow {
  dotElement: HTMLElement;
  sliders: AdjustSlider[];
}

const vscodeApi = acquireVsCodeApi();

const SYNC_TIME_AGO_REFRESH_MILLISECONDS = 30_000;

const ADJUSTMENT_SLIDER_LABELS: [property: keyof ColorAdjustment, label: string][] = [
  ["brightness", "Brightness"],
  ["contrast", "Contrast"],
  ["saturation", "Saturation"],
  ["hue", "Hue"],
];

const ZERO_ADJUSTMENT: ColorAdjustment = { brightness: 0, contrast: 0, saturation: 0, hue: 0 };

/** Its own accordion. Opening a slider row must not close a Colors category. */
const ADJUST_ROW_GROUP_NAME = "themeEditorAdjustRow";

const baseSwitch = getElementById<HTMLDivElement>("baseSwitch");
const savedThemeSelect = getElementById<HTMLSelectElement>("savedThemeSelect");
const createThemeButton = getElementById<HTMLButtonElement>("createThemeButton");
const renameThemeButton = getElementById<HTMLButtonElement>("renameThemeButton");
const duplicateThemeButton = getElementById<HTMLButtonElement>("duplicateThemeButton");
const deleteThemeButton = getElementById<HTMLButtonElement>("deleteThemeButton");
const exportThemeButton = getElementById<HTMLButtonElement>("exportThemeButton");
const exportThemeJsonButton = getElementById<HTMLButtonElement>("exportThemeJsonButton");
const exportThemeVsixButton = getElementById<HTMLButtonElement>("exportThemeVsixButton");
const installThemeButton = getElementById<HTMLButtonElement>("installThemeButton");
const saveRow = getElementById<HTMLDivElement>("saveRow");
const themeNotShowingBar = getElementById<HTMLDivElement>("themeNotShowingBar");
const showEditorThemeButton = getElementById<HTMLButtonElement>("showEditorThemeButton");
const saveThemeButton = getElementById<HTMLButtonElement>("saveThemeButton");
const discardChangesButton = getElementById<HTMLButtonElement>("discardChangesButton");
const themeNameRow = getElementById<HTMLDivElement>("themeNameRow");
const themeNameInput = getElementById<HTMLInputElement>("themeNameInput");
const themeNameConfirmButton = getElementById<HTMLButtonElement>("themeNameConfirmButton");
const themeNameCancelButton = getElementById<HTMLButtonElement>("themeNameCancelButton");
const importWholeThemeButton = getElementById<HTMLButtonElement>("importWholeThemeButton");
const wholeThemeTakenFrom = getElementById<HTMLSpanElement>("wholeThemeTakenFrom");
const takeCategoryList = getElementById<HTMLDivElement>("takeCategoryList");
const adjustWholeThemeRow = getElementById<HTMLDivElement>("adjustWholeThemeRow");
const adjustCategoryList = getElementById<HTMLDivElement>("adjustCategoryList");
const searchInput = getElementById<HTMLInputElement>("searchInput");
const applyFailure = getElementById<HTMLParagraphElement>("applyFailure");
const categoryList = getElementById<HTMLDivElement>("categoryList");
const syncStatus = getElementById<HTMLParagraphElement>("syncStatus");
const enableSyncButton = getElementById<HTMLButtonElement>("enableSyncButton");
const signInButton = getElementById<HTMLButtonElement>("signInButton");
const syncNowButton = getElementById<HTMLButtonElement>("syncNowButton");
const disableSyncButton = getElementById<HTMLButtonElement>("disableSyncButton");

const rowsByColorId = new Map<string, ColorKeyRow>();
const categorySections: CategorySection[] = [];

const takenFromElementByCategoryId = new Map<string, { takenFromElement: HTMLElement; restoreButton: HTMLButtonElement }>();

// The picker drops alpha. These keep it, for keys the theme sets and for keys that show their default.
const currentValueByColorId = new Map<string, string | null>();
const defaultValueByColorId = new Map<string, string | null>();

const colorChangeSender = createThrottledSender<string, string | null>((colorId, value) => {
  postToExtension({ kind: "setColor", colorId, value });
});

const adjustRowByTakeTargetId = new Map<string, AdjustRow>();

const adjustmentChangeSender = createThrottledSender<string, ColorAdjustment>((takeTargetId, adjustment) => {
  postToExtension({ kind: "setColorAdjustment", takeTargetId, adjustment });
});

let expandedCategoryIds = new Set<string>();
let builtCategoryStructure = "";
let themeNameMode: "create" | "rename" | null = null;
let shownSyncState: SyncState = { status: "off" };

startPage();

function startPage(): void {
  restorePersistedViewState();

  initSyntaxPanel(getElementById<HTMLDivElement>("syntaxPanel"), {
    changeTokenColorRule: (ruleIndex, ruleChanges) => postToExtension({ kind: "setTokenColorRule", ruleIndex, ...ruleChanges }),
    deleteTokenColorRule: ruleIndex => postToExtension({ kind: "deleteTokenColorRule", ruleIndex }),
    createTokenColorRuleForScope: (scope, foreground) =>
      postToExtension({ kind: "createTokenColorRuleForScope", scope, foreground }),
    changeTokenInspectionEnabled: isEnabled => postToExtension({ kind: "setTokenInspectionEnabled", isEnabled }),
  });

  listenForMessages();
  listenForThemeCommands();
  listenForMixCommands();
  listenForSyncCommands();
  listenForSearch();
  listenForColorEdits();

  postToExtension({ kind: "ready" });
}

function restorePersistedViewState(): void {
  const persistedViewState = vscodeApi.getState();
  if (!persistedViewState) return;

  searchInput.value = persistedViewState.searchText;
  expandedCategoryIds = new Set(persistedViewState.expandedCategoryIds);
}

function persistViewState(): void {
  // A search opens and closes categories on its own. Only a click should be remembered.
  if (searchInput.value.trim() === "") {
    const openSections = categorySections.filter(section => section.detailsElement.open);
    expandedCategoryIds = new Set(openSections.map(section => section.categoryId));
  }

  vscodeApi.setState({
    searchText: searchInput.value,
    expandedCategoryIds: [...expandedCategoryIds],
  });
}

function postToExtension(message: WebviewToExtensionMessage): void {
  vscodeApi.postMessage(message);
}

function listenForMessages(): void {
  addEventListener("message", event => {
    const message = event.data as ExtensionToWebviewMessage;

    if (message.kind === "state") {
      showState(message.state);
      return;
    }

    if (message.kind === "tokenInspection") {
      showTokenInspection(message.inspection);
    }
  });
}

function showState(state: EditorState): void {
  showBase(state.base);
  showSavedThemes(state.savedThemes);
  saveRow.hidden = !state.hasUnsavedChanges;
  themeNotShowingBar.hidden = state.isEditorThemeShowing;
  showCategories(state.categories, state.wholeThemeTakenFromLabel);
  showTakenFrom(wholeThemeTakenFrom, state.wholeThemeTakenFromLabel);
  showColorAdjustments(state.colorAdjustments);
  showTokenColorRules(state.tokenColorRules);
  showTokenInspectionEnabled(state.isTokenInspectionEnabled);
  showApplyFailure(state.applyFailure);
  showSyncState(state.syncState);

  persistViewState();
}

// ---------------------------------------------------------------------------------------------
// Base

function showBase(base: ThemeBaseKind): void {
  for (const baseOption of baseSwitch.querySelectorAll<HTMLButtonElement>(".base-option")) {
    const isSelectedBase = baseOption.dataset.base === base;
    baseOption.classList.toggle("is-selected", isSelectedBase);
    baseOption.setAttribute("aria-pressed", String(isSelectedBase));
  }
}

// ---------------------------------------------------------------------------------------------
// Saved themes

function showSavedThemes(savedThemes: SavedThemeView[]): void {
  const activeSavedTheme = savedThemes.find(savedTheme => savedTheme.isActive);

  savedThemeSelect.replaceChildren();

  if (savedThemes.length === 0) {
    savedThemeSelect.append(createOption("", "No saved themes yet"));
  }

  for (const savedTheme of savedThemes) {
    const option = createOption(savedTheme.id, `${savedTheme.name} (${savedTheme.base})`);
    option.dataset.savedThemeName = savedTheme.name;

    savedThemeSelect.append(option);
  }

  selectValueWhenListed(savedThemeSelect, activeSavedTheme?.id ?? "");
  savedThemeSelect.disabled = savedThemes.length === 0;

  const hasSelectedSavedTheme = activeSavedTheme !== undefined;
  renameThemeButton.disabled = !hasSelectedSavedTheme;
  duplicateThemeButton.disabled = !hasSelectedSavedTheme;
  deleteThemeButton.disabled = !hasSelectedSavedTheme;

  if (themeNameMode === "rename" && activeSavedTheme) {
    themeNameInput.value = activeSavedTheme.name;
  }
}

function listenForThemeCommands(): void {
  baseSwitch.addEventListener("click", event => {
    const baseOption = (event.target as HTMLElement).closest<HTMLButtonElement>(".base-option");
    if (!baseOption?.dataset.base) return;

    postToExtension({ kind: "setBase", base: baseOption.dataset.base as "dark" | "light" });
  });

  savedThemeSelect.addEventListener("change", () => {
    if (savedThemeSelect.value) {
      postToExtension({ kind: "selectSavedTheme", savedThemeId: savedThemeSelect.value });
    }
  });

  createThemeButton.addEventListener("click", () => openThemeNameRow("create", ""));
  renameThemeButton.addEventListener("click", () => openThemeNameRow("rename", getSelectedSavedThemeName()));

  duplicateThemeButton.addEventListener("click", () => {
    if (savedThemeSelect.value) {
      postToExtension({ kind: "duplicateSavedTheme", savedThemeId: savedThemeSelect.value });
    }
  });

  deleteThemeButton.addEventListener("click", () => {
    if (savedThemeSelect.value) {
      postToExtension({ kind: "deleteSavedTheme", savedThemeId: savedThemeSelect.value });
    }
  });

  themeNameConfirmButton.addEventListener("click", () => confirmThemeName());
  themeNameCancelButton.addEventListener("click", () => closeThemeNameRow());

  themeNameInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      confirmThemeName();
    } else if (event.key === "Escape") {
      closeThemeNameRow();
    }
  });
}

function openThemeNameRow(mode: "create" | "rename", name: string): void {
  themeNameMode = mode;
  themeNameRow.hidden = false;
  themeNameInput.value = name;
  themeNameInput.focus();
  themeNameInput.select();
}

function closeThemeNameRow(): void {
  themeNameMode = null;
  themeNameRow.hidden = true;
  themeNameInput.value = "";
}

function confirmThemeName(): void {
  const name = themeNameInput.value.trim();
  if (!name) return;

  if (themeNameMode === "create") {
    postToExtension({ kind: "createSavedTheme", name });
  } else if (themeNameMode === "rename" && savedThemeSelect.value) {
    postToExtension({ kind: "renameSavedTheme", savedThemeId: savedThemeSelect.value, name });
  }

  closeThemeNameRow();
}

function getSelectedSavedThemeName(): string {
  return savedThemeSelect.selectedOptions[0]?.dataset.savedThemeName ?? "";
}

// ---------------------------------------------------------------------------------------------
// Mixing from an installed theme

function buildImportCategories(categories: ColorCategoryView[]): void {
  takenFromElementByCategoryId.clear();

  const listFragment = document.createDocumentFragment();

  for (const category of categories) {
    if (!category.canImportFromTheme) continue;

    listFragment.append(createTakeCategoryTarget(category));
  }

  takeCategoryList.replaceChildren(listFragment);
}

function createTakeCategoryTarget(category: ColorCategoryView): HTMLElement {
  const rowElement = document.createElement("div");
  rowElement.className = "take-row";

  const textElement = document.createElement("div");
  textElement.className = "take-row-text";

  const nameElement = document.createElement("span");
  nameElement.className = "take-row-name";
  nameElement.textContent = category.label;

  const takenFromElement = document.createElement("span");
  takenFromElement.className = "taken-from";

  textElement.append(nameElement, takenFromElement);

  const restoreButton = document.createElement("button");
  restoreButton.type = "button";
  restoreButton.className = "take-restore";
  restoreButton.textContent = "×";
  restoreButton.title = "Go back to the whole theme's colors for this part";
  restoreButton.addEventListener("click", () =>
    postToExtension({ kind: "restoreCategoryFromWholeTheme", categoryId: category.id })
  );

  const pickButton = document.createElement("button");
  pickButton.type = "button";
  pickButton.className = "take-pick";
  pickButton.textContent = "Choose…";
  pickButton.title = `Borrow the ${category.label.toLowerCase()} colors from another theme`;
  pickButton.addEventListener("click", () => postToExtension({ kind: "pickAndTakeCategory", categoryId: category.id }));

  rowElement.append(textElement, restoreButton, pickButton);
  takenFromElementByCategoryId.set(category.id, { takenFromElement, restoreButton });

  return rowElement;
}

function showImportCategories(categories: ColorCategoryView[], wholeThemeTakenFromLabel: string | null): void {
  for (const category of categories) {
    const takeTarget = takenFromElementByCategoryId.get(category.id);
    if (!takeTarget) continue;

    // A category says where it came from only when that differs from the whole theme.
    const isTakenFromElsewhere = category.takenFromThemeLabel !== wholeThemeTakenFromLabel;

    showTakenFrom(takeTarget.takenFromElement, isTakenFromElsewhere ? category.takenFromThemeLabel : null);
    takeTarget.restoreButton.hidden = !isTakenFromElsewhere || wholeThemeTakenFromLabel === null;
  }
}

function showTakenFrom(takenFromElement: HTMLElement, takenFromThemeLabel: string | null): void {
  takenFromElement.textContent = takenFromThemeLabel ? `from ${takenFromThemeLabel}` : "";
  takenFromElement.hidden = !takenFromThemeLabel;
}

function listenForMixCommands(): void {
  importWholeThemeButton.addEventListener("click", () => postToExtension({ kind: "pickAndTakeWholeTheme" }));

  exportThemeButton.addEventListener("click", () => postToExtension({ kind: "exportTheme" }));
  exportThemeJsonButton.addEventListener("click", () => postToExtension({ kind: "exportThemeJson" }));
  exportThemeVsixButton.addEventListener("click", () => postToExtension({ kind: "exportThemeVsix" }));
  installThemeButton.addEventListener("click", () => postToExtension({ kind: "installTheme" }));

  saveThemeButton.addEventListener("click", () => postToExtension({ kind: "saveTheme" }));
  discardChangesButton.addEventListener("click", () => postToExtension({ kind: "discardChanges" }));
  showEditorThemeButton.addEventListener("click", () => postToExtension({ kind: "showEditorTheme" }));
}

// ---------------------------------------------------------------------------------------------
// Adjusting colors

// Built from the same rows as Borrow, so the two lists cannot drift.
function buildAdjustRows(categories: ColorCategoryView[]): void {
  adjustRowByTakeTargetId.clear();

  const wholeThemeRow = createAdjustRow(WHOLE_THEME_TAKE_TARGET_ID, "Whole theme");
  wholeThemeRow.classList.add("adjust-row-whole");
  adjustWholeThemeRow.replaceChildren(wholeThemeRow);

  const listFragment = document.createDocumentFragment();

  for (const category of categories) {
    if (!category.canImportFromTheme) continue;

    listFragment.append(createAdjustRow(category.id, category.label));
  }

  adjustCategoryList.replaceChildren(listFragment);
}

function createAdjustRow(takeTargetId: string, label: string): HTMLDetailsElement {
  const detailsElement = document.createElement("details");
  detailsElement.className = "adjust-row";
  detailsElement.name = ADJUST_ROW_GROUP_NAME;

  const summaryElement = document.createElement("summary");
  summaryElement.className = "take-row adjust-row-summary";

  const nameElement = document.createElement("span");
  nameElement.className = "take-row-name";
  nameElement.textContent = label;

  const dotElement = document.createElement("span");
  dotElement.className = "adjust-dot";
  dotElement.title = "A slider is off center";
  dotElement.hidden = true;

  summaryElement.append(nameElement, dotElement);

  const bodyElement = document.createElement("div");
  bodyElement.className = "adjust-row-body";

  const sliders = ADJUSTMENT_SLIDER_LABELS.map(([property, sliderLabel]) => createAdjustSlider(property, sliderLabel));
  bodyElement.append(...sliders.map(slider => slider.labelElement));

  const resetButton = document.createElement("button");
  resetButton.type = "button";
  resetButton.className = "adjust-reset";
  resetButton.textContent = "Reset";
  resetButton.title = "Put every slider back to the middle";
  bodyElement.append(resetButton);

  detailsElement.append(summaryElement, bodyElement);

  const row: AdjustRow = { dotElement, sliders };
  adjustRowByTakeTargetId.set(takeTargetId, row);

  bodyElement.addEventListener("input", event => {
    if (event.target instanceof HTMLInputElement && event.target.type === "range") {
      sendAdjustmentFromRow(takeTargetId, row);
    }
  });

  resetButton.addEventListener("click", () => {
    for (const slider of row.sliders) {
      slider.rangeInput.value = "0";
    }

    sendAdjustmentFromRow(takeTargetId, row);
  });

  return detailsElement;
}

function createAdjustSlider(property: keyof ColorAdjustment, label: string): AdjustSlider {
  const labelElement = document.createElement("label");
  labelElement.className = "adjust-slider";

  const textElement = document.createElement("span");
  textElement.textContent = label;

  const valueElement = document.createElement("span");
  valueElement.className = "adjust-slider-value";

  const rangeInput = document.createElement("input");
  rangeInput.type = "range";
  rangeInput.min = String(-ADJUSTMENT_LIMITS[property]);
  rangeInput.max = String(ADJUSTMENT_LIMITS[property]);
  rangeInput.step = "1";
  rangeInput.value = "0";

  labelElement.append(textElement, valueElement, rangeInput);

  return { property, labelElement, rangeInput, valueElement };
}

function showColorAdjustments(colorAdjustments: Record<string, ColorAdjustment>): void {
  for (const [takeTargetId, row] of adjustRowByTakeTargetId) {
    showAdjustmentInRow(takeTargetId, row, colorAdjustments[takeTargetId] ?? ZERO_ADJUSTMENT);
  }
}

function showAdjustmentInRow(takeTargetId: string, row: AdjustRow, adjustment: ColorAdjustment): void {
  // A dragged range holds focus, and a state that lands then is older than the range. The queue check catches Reset.
  const isRowBeingEdited = adjustmentChangeSender.hasQueuedChange(takeTargetId);

  let isOffCenter = false;

  for (const slider of row.sliders) {
    if (!isRowBeingEdited && document.activeElement !== slider.rangeInput) {
      slider.rangeInput.value = String(adjustment[slider.property]);
    }

    const shownValue = Number(slider.rangeInput.value);
    slider.valueElement.textContent = shownValue > 0 ? `+${shownValue}` : String(shownValue);
    isOffCenter ||= shownValue !== 0;
  }

  row.dotElement.hidden = !isOffCenter;
}

function sendAdjustmentFromRow(takeTargetId: string, row: AdjustRow): void {
  const adjustment: ColorAdjustment = { ...ZERO_ADJUSTMENT };

  for (const slider of row.sliders) {
    adjustment[slider.property] = Number(slider.rangeInput.value);
  }

  adjustmentChangeSender.send(takeTargetId, adjustment);
  showAdjustmentInRow(takeTargetId, row, adjustment);
}

// ---------------------------------------------------------------------------------------------
// Sync

function listenForSyncCommands(): void {
  enableSyncButton.addEventListener("click", () => postToExtension({ kind: "enableSync" }));
  signInButton.addEventListener("click", () => postToExtension({ kind: "enableSync" }));
  syncNowButton.addEventListener("click", () => postToExtension({ kind: "syncNow" }));
  disableSyncButton.addEventListener("click", () => postToExtension({ kind: "disableSync" }));

  // "2 min ago" goes stale on its own.
  setInterval(() => showSyncState(shownSyncState), SYNC_TIME_AGO_REFRESH_MILLISECONDS);
}

function showSyncState(state: SyncState): void {
  shownSyncState = state;

  syncStatus.textContent = getSyncStatusText(state);
  syncStatus.classList.toggle("is-error", state.status === "error");

  enableSyncButton.hidden = state.status !== "off";
  signInButton.hidden = state.status !== "paused";
  syncNowButton.hidden = state.status !== "on" && state.status !== "error";
  disableSyncButton.hidden = state.status === "off";
  disableSyncButton.disabled = state.status === "syncing";
}

function getSyncStatusText(state: SyncState): string {
  const timeAgo = state.lastSyncedAt ? formatTimeAgo(state.lastSyncedAt) : "never";

  switch (state.status) {
    case "off": {
      return "Keep your themes on every machine.";
    }

    case "syncing": {
      return state.lastSyncedAt ? "Syncing…" : "Setting up…";
    }

    case "on": {
      const account = state.accountLabel ? `as @${state.accountLabel} ` : "";
      const skipped = state.message ? ` · ${state.message}` : "";

      return `Synced ${account}· ${timeAgo}${skipped}`;
    }

    case "paused": {
      return `Sync paused · ${state.message ?? ""}`;
    }

    case "error": {
      return `Last synced ${timeAgo} · ${state.message ?? ""}`;
    }
  }
}

function formatTimeAgo(isoTime: string): string {
  const elapsedMilliseconds = Date.now() - Date.parse(isoTime);
  if (Number.isNaN(elapsedMilliseconds)) {
    return "never";
  }

  const elapsedMinutes = Math.floor(elapsedMilliseconds / 60_000);
  if (elapsedMinutes < 1) {
    return "just now";
  }

  if (elapsedMinutes < 60) {
    return `${elapsedMinutes} min ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours} h ago`;
  }

  return `${Math.floor(elapsedHours / 24)} d ago`;
}

// ---------------------------------------------------------------------------------------------
// Categories and color keys

// Close to a thousand keys, and a state after every edit. Rows are built once.
function showCategories(categories: ColorCategoryView[], wholeThemeTakenFromLabel: string | null): void {
  const categoryStructure = getCategoryStructure(categories);

  if (categoryStructure !== builtCategoryStructure) {
    buildCategories(categories);
    buildImportCategories(categories);
    buildAdjustRows(categories);
    builtCategoryStructure = categoryStructure;
    applySearch();
  }

  showImportCategories(categories, wholeThemeTakenFromLabel);

  for (const category of categories) {
    for (const colorKey of category.keys) {
      showColorKey(colorKey);
    }
  }
}

function getCategoryStructure(categories: ColorCategoryView[]): string {
  return categories.map(category => `${category.id}:${category.keys.map(colorKey => colorKey.id).join(",")}`).join("|");
}

function buildCategories(categories: ColorCategoryView[]): void {
  rowsByColorId.clear();
  categorySections.length = 0;

  const categoryFragment = document.createDocumentFragment();

  for (const category of categories) {
    if (category.keys.length === 0) continue;

    const detailsElement = document.createElement("details");
    detailsElement.className = "category";
    detailsElement.name = ACCORDION_GROUP_NAME;
    detailsElement.open = expandedCategoryIds.has(category.id);

    const summaryElement = document.createElement("summary");
    summaryElement.className = "category-summary";
    summaryElement.textContent = `${category.label} (${category.keys.length})`;
    detailsElement.append(summaryElement);

    const colorKeyRows = category.keys.map(colorKey => createColorKeyRow(colorKey));
    detailsElement.append(...colorKeyRows.map(colorKeyRow => colorKeyRow.rowElement));

    detailsElement.addEventListener("toggle", () => persistViewState());

    categorySections.push({ categoryId: category.id, detailsElement, colorKeyRows });
    categoryFragment.append(detailsElement);
  }

  categoryList.replaceChildren(categoryFragment);
}

function createColorKeyRow(colorKey: ColorKeyView): ColorKeyRow {
  const rowElement = document.createElement("div");
  rowElement.className = "color-row";
  rowElement.dataset.colorId = colorKey.id;

  const controlsElement = document.createElement("div");
  controlsElement.className = "color-row-controls";

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "color-swatch";
  colorInput.title = colorKey.id;

  const adjustedSwatch = document.createElement("span");
  adjustedSwatch.className = "color-swatch-adjusted";
  adjustedSwatch.title = "As painted after the adjustment sliders";
  adjustedSwatch.hidden = true;

  const hexInput = document.createElement("input");
  hexInput.type = "text";
  hexInput.className = "color-hex";
  hexInput.spellcheck = false;

  const flashButton = document.createElement("button");
  flashButton.type = "button";
  flashButton.className = "flash-button";
  flashButton.title = "Blink this color so you can see what it paints";
  flashButton.textContent = "◉";
  flashButton.addEventListener("click", () => postToExtension({ kind: "flashColor", colorId: colorKey.id }));

  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "clear-button";
  clearButton.title = "Clear back to the default";
  clearButton.textContent = "×";

  controlsElement.append(colorInput, adjustedSwatch, hexInput, flashButton, clearButton);

  const idElement = document.createElement("div");
  idElement.className = "color-row-id";
  idElement.textContent = colorKey.id;

  const descriptionElement = document.createElement("div");
  descriptionElement.className = "color-row-description";
  descriptionElement.textContent = colorKey.description;

  rowElement.append(controlsElement, idElement, descriptionElement);

  const row: ColorKeyRow = {
    rowElement,
    colorInput,
    adjustedSwatch,
    hexInput,
    clearButton,
    searchText: `${colorKey.id} ${colorKey.description}`.toLowerCase(),
  };

  rowsByColorId.set(colorKey.id, row);
  showColorKeyInRow(row, colorKey);

  return row;
}

function showColorKey(colorKey: ColorKeyView): void {
  const row = rowsByColorId.get(colorKey.id);

  if (row) {
    showColorKeyInRow(row, colorKey);
  }
}

function showColorKeyInRow(row: ColorKeyRow, colorKey: ColorKeyView): void {
  currentValueByColorId.set(colorKey.id, colorKey.value);
  defaultValueByColorId.set(colorKey.id, colorKey.defaultValue);

  const effectiveValue = colorKey.value ?? colorKey.defaultValue;
  const swatchValue = getSwatchValue(effectiveValue);

  // A state that arrives mid drag is older than the swatch. Writing it back would snap the picker backwards.
  const hasQueuedColorEdit = colorChangeSender.hasQueuedChange(colorKey.id);
  if (!hasQueuedColorEdit && row.colorInput.value !== swatchValue) {
    row.colorInput.value = swatchValue;
  }

  if (document.activeElement !== row.hexInput) {
    row.hexInput.value = colorKey.value ?? "";
  }

  row.hexInput.placeholder = colorKey.defaultValue ?? "no default";

  // The stored value stays the one being edited. The second swatch only says what a slider made of it.
  const isAdjusted =
    colorKey.value !== null &&
    colorKey.adjustedValue !== null &&
    getComparableHexColor(colorKey.value) !== getComparableHexColor(colorKey.adjustedValue);

  row.adjustedSwatch.hidden = !isAdjusted;
  row.adjustedSwatch.style.background = colorKey.adjustedValue ?? "";

  const isSetByTheme = colorKey.value !== null;
  row.clearButton.disabled = !isSetByTheme;
  row.rowElement.classList.toggle("is-set", isSetByTheme);
}

function listenForColorEdits(): void {
  categoryList.addEventListener("input", event => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("color-swatch")) return;

    const colorId = getRowColorId(target);
    if (!colorId) return;

    const pickedValue = (target as HTMLInputElement).value;
    const shownValue = currentValueByColorId.get(colorId) ?? defaultValueByColorId.get(colorId);

    sendColorChange(colorId, getColorWithCurrentAlpha(shownValue, pickedValue));
  });

  categoryList.addEventListener("change", event => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("color-hex")) return;

    const colorId = getRowColorId(target);
    if (!colorId) return;

    const typedValue = (target as HTMLInputElement).value.trim();

    if (typedValue === "") {
      sendColorChange(colorId, null);
      return;
    }

    if (!HEX_COLOR_PATTERN.test(typedValue)) {
      (target as HTMLInputElement).value = currentValueByColorId.get(colorId) ?? "";
      return;
    }

    sendColorChange(colorId, typedValue);
  });

  categoryList.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("clear-button")) return;

    const colorId = getRowColorId(target);
    if (!colorId) return;

    sendColorChange(colorId, null);
  });
}

function getRowColorId(element: HTMLElement): string | undefined {
  return element.closest<HTMLElement>(".color-row")?.dataset.colorId;
}

function sendColorChange(colorId: string, value: string | null): void {
  currentValueByColorId.set(colorId, value);
  colorChangeSender.send(colorId, value);
}

// An adjusted color comes back as lowercase 6 or 8 digit hex, even when nothing moved it. Compare on that footing.
function getComparableHexColor(value: string): string {
  if (!HEX_COLOR_PATTERN.test(value)) {
    return value;
  }

  return expandShorthandHexColor(value).toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Search

function listenForSearch(): void {
  searchInput.addEventListener("input", () => {
    applySearch();
    persistViewState();
  });
}

function applySearch(): void {
  const query = searchInput.value.trim().toLowerCase();
  const isSearching = query !== "";

  for (const section of categorySections) {
    let matchingRowCount = 0;

    for (const row of section.colorKeyRows) {
      const isMatch = !isSearching || row.searchText.includes(query);
      row.rowElement.hidden = !isMatch;

      if (isMatch) {
        matchingRowCount++;
      }
    }

    // A named details closes its siblings when it opens. A search has to show every section that matched.
    section.detailsElement.name = isSearching ? "" : ACCORDION_GROUP_NAME;

    section.detailsElement.hidden = matchingRowCount === 0;
    section.detailsElement.open = isSearching ? matchingRowCount > 0 : expandedCategoryIds.has(section.categoryId);
  }
}

// ---------------------------------------------------------------------------------------------
// Shared bits

function showApplyFailure(message: string | null): void {
  applyFailure.textContent = message ?? "";
  applyFailure.hidden = !message;
}

// Assigning a value no option has deselects every option.
function selectValueWhenListed(select: HTMLSelectElement, value: string): void {
  const isValueListed = [...select.options].some(option => option.value === value);

  if (isValueListed) {
    select.value = value;
  }
}

function createOption(value: string, label: string): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;

  return option;
}

function getElementById<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.querySelector<ElementType>(`#${id}`);
  if (!element) {
    throw new Error(`The theme editor page has no element with the id ${id}.`);
  }

  return element;
}
