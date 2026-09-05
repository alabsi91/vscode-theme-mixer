import assert from "node:assert/strict";
import { test } from "node:test";

import {
  adjustHexColor,
  adjustThemeColors,
  isZeroAdjustment,
  normalizeColorAdjustment,
  setColorAdjustment,
} from "./adjust-colors.ts";

import type { ColorAdjustment } from "./adjust-colors.ts";
import type { ColorThemeDocument } from "./generated-theme-file.ts";

// Run with: node --test src/theme/adjust-colors.test.ts

const ZERO: ColorAdjustment = { brightness: 0, contrast: 0, saturation: 0, hue: 0 };

function createAdjustment(partial: Partial<ColorAdjustment>): ColorAdjustment {
  return { ...ZERO, ...partial };
}

function createTheme(): ColorThemeDocument {
  return {
    name: "Test",
    type: "dark",
    semanticHighlighting: true,
    colors: { "editor.background": "#808080", "terminal.foreground": "#808080", "list.hoverBackground": "red" },
    semanticTokenColors: { variable: "#808080", property: { foreground: "#808080", bold: true } },
    tokenColors: [
      { scope: "comment", settings: { foreground: "#808080", background: "#80808080", fontStyle: "italic" } },
      { scope: "string" },
    ],
    colorAdjustments: { "*whole*": createAdjustment({ brightness: 10 }) },
  };
}

test("zero adjustment is identity apart from normalizing the hex", () => {
  assert.equal(adjustHexColor("#1a2B3c", ZERO), "#1a2b3c");
  assert.equal(adjustHexColor("#1a2b3c80", ZERO), "#1a2b3c80");
});

test("alpha is kept and shorthand hex expands", () => {
  assert.equal(adjustHexColor("#fff", ZERO), "#ffffff");
  assert.equal(adjustHexColor("#f0f8", createAdjustment({ brightness: -100 })), "#00000088");
});

test("a named color is left alone", () => {
  assert.equal(adjustHexColor("red", createAdjustment({ brightness: 50 })), "red");
  assert.equal(adjustHexColor("transparent", createAdjustment({ contrast: 50 })), "transparent");
});

test("brightness scales the channels and clamps at the ends", () => {
  assert.equal(adjustHexColor("#808080", createAdjustment({ brightness: 100 })), "#ffffff");
  assert.equal(adjustHexColor("#808080", createAdjustment({ brightness: -100 })), "#000000");
  assert.equal(adjustHexColor("#404040", createAdjustment({ brightness: 50 })), "#606060");
});

test("contrast pulls towards or away from the middle", () => {
  assert.equal(adjustHexColor("#000000", createAdjustment({ contrast: -100 })), "#808080");
  assert.equal(adjustHexColor("#ffffff", createAdjustment({ contrast: -100 })), "#808080");
  assert.equal(adjustHexColor("#c0c0c0", createAdjustment({ contrast: 100 })), "#ffffff");
});

test("saturation at -100 is gray and at +100 is more vivid", () => {
  assert.equal(adjustHexColor("#ff0000", createAdjustment({ saturation: -100 })), "#363636");
  assert.equal(adjustHexColor("#c08080", createAdjustment({ saturation: 100 })), "#f27272");
});

test("hue rotates around the wheel, and gray does not move", () => {
  assert.equal(adjustHexColor("#ff0000", createAdjustment({ hue: 180 })), "#006d6d");
  assert.equal(adjustHexColor("#ff0000", createAdjustment({ hue: -180 })), "#006d6d");
  assert.equal(adjustHexColor("#808080", createAdjustment({ hue: 90 })), "#808080");
  assert.equal(adjustHexColor("#4080c0", createAdjustment({ hue: 0 })), "#4080c0");
});

test("hue is clamped to its own limit", () => {
  assert.deepEqual(normalizeColorAdjustment({ hue: 400, brightness: 400 }), createAdjustment({ hue: 180, brightness: 100 }));
});

test("a syntax step leaves the workbench colors alone", () => {
  const adjusted = adjustThemeColors(createTheme(), [
    { colorIds: [], includesSyntax: true, adjustment: createAdjustment({ brightness: 100 }) },
  ]);

  assert.equal(adjusted.colors["editor.background"], "#808080");
  assert.deepEqual(adjusted.tokenColors[0], {
    scope: "comment",
    settings: { foreground: "#ffffff", background: "#ffffff80", fontStyle: "italic" },
  });
  assert.deepEqual(adjusted.tokenColors[1], { scope: "string" });
  assert.equal(adjusted.semanticTokenColors.variable, "#ffffff");
  assert.deepEqual(adjusted.semanticTokenColors.property, { foreground: "#ffffff", bold: true });
});

test("a bucket step leaves keys outside the bucket alone", () => {
  const adjusted = adjustThemeColors(createTheme(), [
    { colorIds: ["editor.background", "editor.foreground"], includesSyntax: false, adjustment: createAdjustment({ brightness: 100 }) },
  ]);

  assert.equal(adjusted.colors["editor.background"], "#ffffff");
  assert.equal(adjusted.colors["terminal.foreground"], "#808080");
  assert.equal(adjusted.colors["editor.foreground"], undefined);
  assert.equal(adjusted.colors["list.hoverBackground"], "red");
  assert.equal(adjusted.semanticTokenColors.variable, "#808080");
});

test("the whole theme applies after a bucket", () => {
  const adjusted = adjustThemeColors(createTheme(), [
    { colorIds: ["editor.background"], includesSyntax: false, adjustment: createAdjustment({ brightness: -50 }) },
    { colorIds: ["editor.background", "terminal.foreground"], includesSyntax: true, adjustment: createAdjustment({ brightness: 50 }) },
  ]);

  assert.equal(adjusted.colors["editor.background"], "#606060");
  assert.equal(adjusted.colors["terminal.foreground"], "#c0c0c0");
});

test("the output has no colorAdjustments and the input is untouched", () => {
  const theme = createTheme();
  const adjusted = adjustThemeColors(theme, [{ colorIds: ["editor.background"], includesSyntax: false, adjustment: createAdjustment({ brightness: 100 }) }]);

  assert.equal("colorAdjustments" in adjusted, false);
  assert.deepEqual(theme.colorAdjustments, { "*whole*": createAdjustment({ brightness: 10 }) });
  assert.equal(theme.colors["editor.background"], "#808080");
});

test("normalizeColorAdjustment gives zeros for garbage and clamps the rest", () => {
  assert.deepEqual(normalizeColorAdjustment(undefined), ZERO);
  assert.deepEqual(normalizeColorAdjustment("nope"), ZERO);
  assert.deepEqual(normalizeColorAdjustment({ brightness: "12", contrast: Number.NaN, saturation: Infinity }), ZERO);
  assert.deepEqual(normalizeColorAdjustment({ brightness: 250, contrast: -250, saturation: 12.6 }), {
    brightness: 100,
    contrast: -100,
    saturation: 13,
    hue: 0,
  });
  assert.equal(isZeroAdjustment(normalizeColorAdjustment(null)), true);
});

test("setColorAdjustment drops the entry at zero and the map when empty", () => {
  const theme = createTheme();

  setColorAdjustment(theme, "editor", createAdjustment({ contrast: 20 }));
  assert.deepEqual(theme.colorAdjustments?.editor, createAdjustment({ contrast: 20 }));

  setColorAdjustment(theme, "editor", ZERO);
  assert.equal(theme.colorAdjustments?.editor, undefined);
  assert.deepEqual(Object.keys(theme.colorAdjustments ?? {}), ["*whole*"]);

  setColorAdjustment(theme, "*whole*", ZERO);
  assert.equal("colorAdjustments" in theme, false);

  setColorAdjustment(theme, "terminal", ZERO);
  assert.equal("colorAdjustments" in theme, false);
});
