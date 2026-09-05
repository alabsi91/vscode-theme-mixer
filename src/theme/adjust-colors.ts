import { clampColorChannel, formatHexColor, parseHexColor } from "./hex-color.ts";

import type { ColorThemeDocument } from "./generated-theme-file.ts";

// Pure. `node --test` loads this file straight into node, where the vscode module does not exist.

/** 0 is no change. Brightness, contrast and saturation are -100..100. Hue is a rotation in degrees, -180..180. */
export interface ColorAdjustment {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number;
}

/** One slider row turned into work. Which color ids it touches, and whether the code colors are included. */
export interface AdjustmentStep {
  colorIds: string[];
  includesSyntax: boolean;
  adjustment: ColorAdjustment;
}

export const ADJUSTMENT_PROPERTIES: (keyof ColorAdjustment)[] = ["brightness", "contrast", "saturation", "hue"];

/** Each slider runs from minus this to plus this. */
export const ADJUSTMENT_LIMITS: Record<keyof ColorAdjustment, number> = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  hue: 180,
};

const PERCENT_LIMIT = 100;

const CHANNEL_MIDPOINT = 127.5;

const TOKEN_COLOR_PROPERTIES = ["foreground", "background"];

export function normalizeColorAdjustment(value: unknown): ColorAdjustment {
  const record = isRecord(value) ? value : {};

  return {
    brightness: normalizeAdjustmentValue(record.brightness, ADJUSTMENT_LIMITS.brightness),
    contrast: normalizeAdjustmentValue(record.contrast, ADJUSTMENT_LIMITS.contrast),
    saturation: normalizeAdjustmentValue(record.saturation, ADJUSTMENT_LIMITS.saturation),
    hue: normalizeAdjustmentValue(record.hue, ADJUSTMENT_LIMITS.hue),
  };
}

export function isZeroAdjustment(adjustment: ColorAdjustment): boolean {
  return ADJUSTMENT_PROPERTIES.every(property => adjustment[property] === 0);
}

export function isSameAdjustment(left: ColorAdjustment, right: ColorAdjustment): boolean {
  return ADJUSTMENT_PROPERTIES.every(property => left[property] === right[property]);
}

/** Deletes the entry at zero, and the map when that leaves it empty. */
export function setColorAdjustment(theme: ColorThemeDocument, takeTargetId: string, adjustment: ColorAdjustment): void {
  if (!isZeroAdjustment(adjustment)) {
    theme.colorAdjustments ??= {};
    theme.colorAdjustments[takeTargetId] = adjustment;
    return;
  }

  if (!theme.colorAdjustments) return;

  delete theme.colorAdjustments[takeTargetId];

  if (Object.keys(theme.colorAdjustments).length === 0) {
    delete theme.colorAdjustments;
  }
}

/** CSS filter math, brightness then contrast then saturation then hue. A value that is not hex comes back unchanged. */
export function adjustHexColor(value: string, adjustment: ColorAdjustment): string {
  const channels = parseHexColor(value);
  if (!channels) {
    return value;
  }

  const brightnessFactor = 1 + adjustment.brightness / PERCENT_LIMIT;
  const contrastFactor = 1 + adjustment.contrast / PERCENT_LIMIT;
  const saturationFactor = 1 + adjustment.saturation / PERCENT_LIMIT;

  const brightened = [channels.red, channels.green, channels.blue].map(channel => clampColorChannel(channel * brightnessFactor));

  const contrasted = brightened.map(channel =>
    clampColorChannel((channel - CHANNEL_MIDPOINT) * contrastFactor + CHANNEL_MIDPOINT)
  );

  const [red, green, blue] = contrasted;
  const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;

  const saturated = contrasted.map(channel => clampColorChannel(luma + (channel - luma) * saturationFactor));

  const [rotatedRed, rotatedGreen, rotatedBlue] = rotateHue(saturated, adjustment.hue);

  return formatHexColor({
    red: rotatedRed,
    green: rotatedGreen,
    blue: rotatedBlue,
    alphaHexDigits: channels.alphaHexDigits,
  });
}

// The hue-rotate matrix from the CSS filter effects spec. Gray stays gray, because every row sums to one.
function rotateHue(channels: number[], degrees: number): number[] {
  if (degrees === 0) {
    return channels;
  }

  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  const matrix = [
    [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928],
    [0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283],
    [0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072],
  ];

  const [red, green, blue] = channels;

  return matrix.map(row => clampColorChannel(row[0] * red + row[1] * green + row[2] * blue));
}

/** Applies the steps in order to a clone. Only keys the theme sets change. The clone carries no `colorAdjustments`. */
export function adjustThemeColors(theme: ColorThemeDocument, steps: AdjustmentStep[]): ColorThemeDocument {
  const adjustedTheme = structuredClone(theme);
  delete adjustedTheme.colorAdjustments;

  for (const step of steps) {
    for (const colorId of step.colorIds) {
      const value = adjustedTheme.colors[colorId];

      if (value !== undefined) {
        adjustedTheme.colors[colorId] = adjustHexColor(value, step.adjustment);
      }
    }

    if (step.includesSyntax) {
      adjustSyntaxColors(adjustedTheme, step.adjustment);
    }
  }

  return adjustedTheme;
}

function adjustSyntaxColors(theme: ColorThemeDocument, adjustment: ColorAdjustment): void {
  for (const entry of theme.tokenColors) {
    const settings = isRecord(entry) ? entry.settings : undefined;
    if (!isRecord(settings)) continue;

    for (const property of TOKEN_COLOR_PROPERTIES) {
      const value = settings[property];

      if (typeof value === "string") {
        settings[property] = adjustHexColor(value, adjustment);
      }
    }
  }

  for (const [tokenType, value] of Object.entries(theme.semanticTokenColors)) {
    if (typeof value === "string") {
      theme.semanticTokenColors[tokenType] = adjustHexColor(value, adjustment);
      continue;
    }

    if (isRecord(value) && typeof value.foreground === "string") {
      value.foreground = adjustHexColor(value.foreground, adjustment);
    }
  }
}

function normalizeAdjustmentValue(value: unknown, limit: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.min(limit, Math.max(-limit, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
