import assert from "node:assert/strict";
import { test } from "node:test";

import { getReplacementColor, groupColorsIntoSwatches } from "./theme-palette.ts";

import type { PaletteMember } from "./theme-palette.ts";

// Run with: node --test src/theme/theme-palette.test.ts

function createMembers(valueById: Record<string, string>): PaletteMember[] {
  return Object.entries(valueById).map(([item, value]) => ({ item, value }));
}

test("shades and alpha variants of one hue become one swatch, most used color on top", () => {
  const swatches = groupColorsIntoSwatches(
    createMembers({
      "button.background": "#007acc",
      "badge.background": "#007acc",
      "focusBorder": "#007acc80",
      "list.activeSelectionBackground": "#0a5a96",
      "editor.background": "#1e1e1e",
    })
  );

  assert.equal(swatches.length, 2);
  assert.equal(swatches[0].color, "#007acc");
  assert.deepEqual(
    swatches[0].members.map(member => member.item).sort(),
    ["badge.background", "button.background", "focusBorder", "list.activeSelectionBackground"]
  );
  assert.equal(swatches[1].color, "#1e1e1e");
});

test("all grays become one swatch", () => {
  const swatches = groupColorsIntoSwatches(createMembers({ a: "#1e1e1e", b: "#1e1e1e80", c: "#2a2a2a", d: "#ffffff", e: "not-a-color" }));

  assert.deepEqual(
    swatches.map(swatch => swatch.members.map(member => member.item)),
    [["a", "b", "c", "d"]]
  );
});

test("a tinted gray follows the nearest accent, or the grays when there is none", () => {
  const withAccent = groupColorsIntoSwatches(createMembers({ accent: "#007acc", tintedBackground: "#1e1e2e", red: "#cc0000" }));

  assert.deepEqual(withAccent[0].members.map(member => member.item), ["accent", "tintedBackground"]);

  const withoutAccent = groupColorsIntoSwatches(createMembers({ tintedBackground: "#1e1e2e", gray: "#808080" }));

  assert.equal(withoutAccent.length, 1);
});

test("hues on both sides of red wrap into one swatch", () => {
  const swatches = groupColorsIntoSwatches(createMembers({ a: "#ff0011", b: "#ff1100", c: "#00ff00" }));

  assert.equal(swatches.length, 2);
  assert.deepEqual(swatches[0].members.map(member => member.item), ["b", "a"]);
});

test("a replacement keeps alpha and the lightness gap and takes the new hue", () => {
  const replacement = getReplacementColor("#0a5a9680", "#007acc", "#cc0000");

  assert.equal(replacement.length, 9);
  assert.equal(replacement.slice(7), "80");
  assert.equal(replacement.slice(0, 7), "#960e0a");
  assert.equal(getReplacementColor("#007acc", "#007acc", "#cc0000"), "#cc0000");
});

test("picking the swatch color back gives every member its saved value", () => {
  assert.equal(getReplacementColor("#3794ff", "#007acc", "#007acc"), "#3794ff");
  assert.equal(getReplacementColor("#1e1e2e", "#007acc", "#007acc"), "#1e1e2e");
  assert.equal(getReplacementColor("#333333", "#252526", "#252526"), "#333333");
});

test("a dark pick darkens every shade, and the swatch color becomes the pick exactly", () => {
  assert.equal(getReplacementColor("#007acc", "#007acc", "#400000"), "#400000");
  assert.equal(getReplacementColor("#0a5a96", "#007acc", "#400000"), "#130201");
});

test("a gray swatch takes the new color's saturation", () => {
  assert.equal(getReplacementColor("#808080", "#808080", "#ff0000"), "#ff0000");
  assert.equal(getReplacementColor("red", "#808080", "#ff0000"), "red");
});

test("a near gray swatch color counts as gray, so pure grays in it move too", () => {
  assert.equal(getReplacementColor("#252526", "#252526", "#ff0000"), "#ff0000");
  assert.equal(getReplacementColor("#1e1e1e", "#252526", "#ff0000"), "#ee0202");
  assert.equal(getReplacementColor("#333333", "#252526", "#ff0000"), "#fd1d1d");
});

test("a gray swatch headed by a tint still moves its pure grays", () => {
  assert.equal(getReplacementColor("#2c2a27", "#2c2a27", "#ff0000"), "#ff0000");
  assert.equal(getReplacementColor("#1e1e1e", "#2c2a27", "#ff0000"), "#e10707");
});
