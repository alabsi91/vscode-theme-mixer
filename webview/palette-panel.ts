import { HEX_COLOR_PATTERN } from "../src/theme/hex-color.ts";
import { getOpaqueHexColor, getReplacementColor, groupColorsIntoSwatches } from "../src/theme/theme-palette.ts";
import { createThrottledSender, getSwatchValue } from "./color-input.ts";

import type { ColorCategoryView, ColorKeyView } from "../src/panel/webview-protocol.ts";
import type { PaletteMember, PaletteSwatch } from "../src/theme/theme-palette.ts";

export interface PalettePanelCallbacks {
  replaceColors(colors: Record<string, string>): void;
  revertColors(colorIds: string[]): void;
  changeTickedCategories(categoryIds: string[]): void;
}

interface PaletteRow {
  swatch: PaletteSwatch;
  colorInput: HTMLInputElement;
  hexInput: HTMLInputElement;
  revertButton: HTMLButtonElement;
}

/** The parts of the window where an accent color usually lives. */
const DEFAULT_TICKED_CATEGORY_IDS = ["widgets", "sidebar", "status", "tabs", "editor", "base"];

const MAXIMUM_TOOLTIP_MEMBERS = 15;

let categoryListElement: HTMLElement;
let swatchListElement: HTMLElement;
let callbacks: PalettePanelCallbacks;

let tickedCategoryIds = new Set<string>(DEFAULT_TICKED_CATEGORY_IDS);
let builtCategoryStructure = "";
let builtSwatchStructure = "";

let latestCategories: ColorCategoryView[] = [];
const colorKeyById = new Map<string, ColorKeyView>();
const rows: PaletteRow[] = [];

const replaceColorsSender = createThrottledSender<string, Record<string, string>>((_swatchColor, colors) => {
  callbacks.replaceColors(colors);
});

export function initPalettePanel(
  categoryList: HTMLElement,
  swatchList: HTMLElement,
  panelCallbacks: PalettePanelCallbacks,
  persistedTickedCategoryIds: string[] | undefined
): void {
  categoryListElement = categoryList;
  swatchListElement = swatchList;
  callbacks = panelCallbacks;

  if (persistedTickedCategoryIds) {
    tickedCategoryIds = new Set(persistedTickedCategoryIds);
  }

  categoryListElement.addEventListener("change", event => {
    const checkbox = event.target as HTMLInputElement;
    if (!checkbox.dataset.categoryId) return;

    if (checkbox.checked) {
      tickedCategoryIds.add(checkbox.dataset.categoryId);
    } else {
      tickedCategoryIds.delete(checkbox.dataset.categoryId);
    }

    callbacks.changeTickedCategories([...tickedCategoryIds]);
    showSwatches();
  });
}

export function showPalette(categories: ColorCategoryView[]): void {
  latestCategories = categories;
  colorKeyById.clear();

  for (const category of categories) {
    for (const colorKey of category.keys) {
      colorKeyById.set(colorKey.id, colorKey);
    }
  }

  const categoryStructure = categories.map(category => `${category.id}:${category.label}`).join("|");

  if (categoryStructure !== builtCategoryStructure) {
    buildCategoryCheckboxes(categories);
    builtCategoryStructure = categoryStructure;
  }

  showSwatches();
}

function buildCategoryCheckboxes(categories: ColorCategoryView[]): void {
  const listFragment = document.createDocumentFragment();

  for (const category of categories) {
    if (category.keys.length === 0) continue;

    const labelElement = document.createElement("label");
    labelElement.className = "category-tick";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.categoryId = category.id;
    checkbox.checked = tickedCategoryIds.has(category.id);

    labelElement.append(checkbox, document.createTextNode(category.label));
    listFragment.append(labelElement);
  }

  categoryListElement.replaceChildren(listFragment);
}

// Groups come from the saved theme, so an edit can never split or merge them. Only the ticked parts change the rows.
function showSwatches(): void {
  const swatches = groupColorsIntoSwatches(collectSavedMembers());
  const swatchStructure = swatches
    .map(swatch => swatch.members.map(member => `${member.item}=${member.value}`).join(","))
    .join("|");

  if (swatchStructure !== builtSwatchStructure) {
    buildRows(swatches);
    builtSwatchStructure = swatchStructure;
  }

  for (const row of rows) {
    showRow(row);
  }
}

function collectSavedMembers(): PaletteMember[] {
  const members: PaletteMember[] = [];

  for (const category of latestCategories) {
    if (!tickedCategoryIds.has(category.id)) continue;

    for (const colorKey of category.keys) {
      if (colorKey.savedValue !== null) {
        members.push({ item: colorKey.id, value: colorKey.savedValue });
      }
    }
  }

  return members;
}

function buildRows(swatches: PaletteSwatch[]): void {
  rows.length = 0;

  const listFragment = document.createDocumentFragment();

  for (const swatch of swatches) {
    listFragment.append(createRow(swatch));
  }

  swatchListElement.replaceChildren(listFragment);
  swatchListElement.hidden = swatches.length === 0;
}

function createRow(swatch: PaletteSwatch): HTMLElement {
  const rowElement = document.createElement("div");
  rowElement.className = "palette-row";
  rowElement.title = getSwatchTooltip(swatch);

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "color-swatch";
  colorInput.title = "Pick a new color for everything in this group";

  const hexInput = document.createElement("input");
  hexInput.type = "text";
  hexInput.className = "color-hex";
  hexInput.spellcheck = false;

  const revertButton = document.createElement("button");
  revertButton.type = "button";
  revertButton.className = "clear-button";
  revertButton.textContent = "×";
  revertButton.title = "Put the saved colors back for this group";

  const placeCount = swatch.members.length;

  const countElement = document.createElement("span");
  countElement.className = "palette-row-count";
  countElement.textContent = `${placeCount} ${placeCount === 1 ? "place" : "places"}`;

  rowElement.append(colorInput, hexInput, revertButton, countElement);

  const row: PaletteRow = { swatch, colorInput, hexInput, revertButton };
  rows.push(row);

  colorInput.addEventListener("input", () => {
    hexInput.value = colorInput.value;
    replaceColorsSender.send(swatch.color, createReplacement(swatch, colorInput.value));
  });

  hexInput.addEventListener("change", () => {
    const typedValue = hexInput.value.trim();

    if (!HEX_COLOR_PATTERN.test(typedValue)) {
      hexInput.value = colorInput.value;
      return;
    }

    replaceColorsSender.send(swatch.color, createReplacement(swatch, getSwatchValue(typedValue)));
  });

  revertButton.addEventListener("click", () => {
    replaceColorsSender.clearQueuedChanges();
    callbacks.revertColors(swatch.members.map(member => member.item));
  });

  return rowElement;
}

function showRow(row: PaletteRow): void {
  const currentColor = getCurrentSwatchColor(row.swatch);

  if (!replaceColorsSender.hasQueuedChange(row.swatch.color) && row.colorInput.value !== currentColor) {
    row.colorInput.value = currentColor;
  }

  if (document.activeElement !== row.hexInput) {
    row.hexInput.value = currentColor;
  }

  row.revertButton.hidden = !row.swatch.members.some(member => {
    const colorKey = colorKeyById.get(member.item);
    return colorKey !== undefined && colorKey.value !== colorKey.savedValue;
  });
}

// The color the row shows is what the swatch color became. A member that was the swatch color carries it.
function getCurrentSwatchColor(swatch: PaletteSwatch): string {
  for (const member of swatch.members) {
    if (getOpaqueHexColor(member.value) !== swatch.color) continue;

    const currentValue = colorKeyById.get(member.item)?.value;

    if (currentValue && HEX_COLOR_PATTERN.test(currentValue)) {
      return getOpaqueHexColor(currentValue);
    }
  }

  return swatch.color;
}

function getSwatchTooltip(swatch: PaletteSwatch): string {
  const shownIds = swatch.members.slice(0, MAXIMUM_TOOLTIP_MEMBERS).map(member => member.item);
  const hiddenCount = swatch.members.length - shownIds.length;

  if (hiddenCount > 0) {
    shownIds.push(`… and ${hiddenCount} more`);
  }

  return shownIds.join("\n");
}

function createReplacement(swatch: PaletteSwatch, newColor: string): Record<string, string> {
  const colors: Record<string, string> = {};

  for (const member of swatch.members) {
    colors[member.item] = getReplacementColor(member.value, swatch.color, newColor);
  }

  return colors;
}
