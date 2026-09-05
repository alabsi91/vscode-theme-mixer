import { expandShorthandHexColor, formatHexColor, parseHexColor } from "./hex-color.ts";

// Shared by the extension and the webview. Nothing here may import vscode or node.

/** Hue in degrees 0..360, saturation and lightness 0..1. */
interface HslColor {
  hue: number;
  saturation: number;
  lightness: number;
}

export interface PaletteMember {
  item: string;
  value: string;
}

/** One color the theme uses, with every place it uses it. */
export interface PaletteSwatch {
  /** The most used member color, 6 digit hex. */
  color: string;
  members: PaletteMember[];
}

// ponytail: HSL with fixed limits. OKLCH and per-theme limits can come when one accent's shades land in two swatches.
const HUE_TOLERANCE_DEGREES = 12;
const TINT_HUE_TOLERANCE_DEGREES = 45;
const ACCENT_CHROMA_LIMIT = 0.2;
const GRAY_CHROMA_LIMIT = 0.012;

const FULL_CIRCLE_DEGREES = 360;

interface HuedMember {
  member: PaletteMember;
  hue: number;
}

/**
 * Strong colors group by hue. A faint tint joins the nearest of those groups, so a theme's tinted grays follow its accent. What
 * is left is gray and becomes one swatch. Alpha is ignored. Accents first by use, grays last.
 */
export function groupColorsIntoSwatches(members: PaletteMember[]): PaletteSwatch[] {
  const accentMembers: HuedMember[] = [];
  const tintMembers: HuedMember[] = [];
  const grayMembers: PaletteMember[] = [];

  for (const member of members) {
    const channels = parseHexColor(member.value);
    if (!channels) continue;

    const hsl = getHslColor(channels);
    const chroma = getChroma(hsl);

    if (chroma >= ACCENT_CHROMA_LIMIT) {
      accentMembers.push({ member, hue: hsl.hue });
    } else if (chroma >= GRAY_CHROMA_LIMIT) {
      tintMembers.push({ member, hue: hsl.hue });
    } else {
      grayMembers.push(member);
    }
  }

  const swatches = groupByHue(accentMembers).map(groupMembers => ({
    color: getMostUsedColor(groupMembers),
    members: groupMembers,
  }));

  const swatchHues = swatches.map(swatch => getHslColor(parseHexColor(swatch.color)!).hue);

  for (const tint of tintMembers) {
    const nearestGroupIndex = findNearestSwatchIndex(swatchHues, tint.hue);

    if (nearestGroupIndex === -1) {
      grayMembers.push(tint.member);
    } else {
      swatches[nearestGroupIndex].members.push(tint.member);
    }
  }

  swatches.sort((left, right) => right.members.length - left.members.length);

  if (grayMembers.length > 0) {
    swatches.push({ color: getMostUsedColor(grayMembers), members: grayMembers });
  }

  return swatches;
}

function findNearestSwatchIndex(swatchHues: number[], hue: number): number {
  let nearestIndex = -1;
  let nearestDistance = TINT_HUE_TOLERANCE_DEGREES;

  for (const [index, swatchHue] of swatchHues.entries()) {
    const distance = getHueDistance(swatchHue, hue);

    if (distance <= nearestDistance) {
      nearestIndex = index;
      nearestDistance = distance;
    }
  }

  return nearestIndex;
}

function getHueDistance(left: number, right: number): number {
  const difference = Math.abs(left - right) % FULL_CIRCLE_DEGREES;
  return Math.min(difference, FULL_CIRCLE_DEGREES - difference);
}

/**
 * The member keeps its alpha and its distance in lightness from the swatch color. Hue comes from the new color, saturation scales
 * with it. A member that was the swatch color becomes exactly the new color.
 */
export function getReplacementColor(memberValue: string, swatchColor: string, newColor: string): string {
  const memberChannels = parseHexColor(memberValue);
  const swatchChannels = parseHexColor(swatchColor);
  const newChannels = parseHexColor(newColor);

  if (!memberChannels || !swatchChannels || !newChannels) {
    return memberValue;
  }

  const memberHsl = getHslColor(memberChannels);
  const swatchHsl = getHslColor(swatchChannels);
  const newHsl = getHslColor(newChannels);

  const isGraySwatch = getChroma(swatchHsl) < ACCENT_CHROMA_LIMIT;
  const isGrayMember = getChroma(memberHsl) < GRAY_CHROMA_LIMIT;
  const isTintInAccentSwatch = !isGraySwatch && getChroma(memberHsl) < ACCENT_CHROMA_LIMIT;

  const hueOffset = isGrayMember ? 0 : memberHsl.hue - swatchHsl.hue;
  const replacementHue = (newHsl.hue + hueOffset + FULL_CIRCLE_DEGREES) % FULL_CIRCLE_DEGREES;

  const replacementSaturation = isGraySwatch
    ? memberHsl.saturation + newHsl.saturation - swatchHsl.saturation
    : memberHsl.saturation * (newHsl.saturation / swatchHsl.saturation);

  const lightnessShift = isTintInAccentSwatch ? 0 : newHsl.lightness - swatchHsl.lightness;
  const replacementLightness = memberHsl.lightness + lightnessShift;

  const replacementChannels = getRgbChannels({
    hue: replacementHue,
    saturation: clampUnitInterval(replacementSaturation),
    lightness: clampUnitInterval(replacementLightness),
  });

  return formatHexColor({ ...replacementChannels, alphaHexDigits: memberChannels.alphaHexDigits });
}

export function getOpaqueHexColor(value: string): string {
  return expandShorthandHexColor(value).slice(0, 7).toLowerCase();
}

function clampUnitInterval(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function getChroma(hsl: HslColor): number {
  return hsl.saturation * (1 - Math.abs(2 * hsl.lightness - 1));
}

function getHslColor(channels: { red: number; green: number; blue: number }): HslColor {
  const red = channels.red / 255;
  const green = channels.green / 255;
  const blue = channels.blue / 255;

  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  const lightness = (maximum + minimum) / 2;

  if (chroma === 0) {
    return { hue: 0, saturation: 0, lightness };
  }

  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));

  let hue: number;

  if (maximum === red) {
    hue = ((green - blue) / chroma) % 6;
  } else if (maximum === green) {
    hue = (blue - red) / chroma + 2;
  } else {
    hue = (red - green) / chroma + 4;
  }

  hue *= 60;

  if (hue < 0) {
    hue += FULL_CIRCLE_DEGREES;
  }

  return { hue, saturation, lightness };
}

function getRgbChannels(hsl: HslColor): { red: number; green: number; blue: number } {
  const chroma = (1 - Math.abs(2 * hsl.lightness - 1)) * hsl.saturation;
  const hueSector = hsl.hue / 60;
  const secondary = chroma * (1 - Math.abs((hueSector % 2) - 1));
  const offset = hsl.lightness - chroma / 2;

  const sectorChannels = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ];

  const [red, green, blue] = sectorChannels[Math.floor(hueSector) % 6];

  return { red: (red + offset) * 255, green: (green + offset) * 255, blue: (blue + offset) * 255 };
}

function groupByHue(huedMembers: HuedMember[]): PaletteMember[][] {
  const sortedMembers = huedMembers.toSorted((left, right) => left.hue - right.hue);
  const memberGroups: PaletteMember[][] = [];

  let currentGroup: PaletteMember[] | undefined;
  let previousHue = 0;

  for (const { member, hue } of sortedMembers) {
    if (!currentGroup || hue - previousHue > HUE_TOLERANCE_DEGREES) {
      currentGroup = [];
      memberGroups.push(currentGroup);
    }

    currentGroup.push(member);
    previousHue = hue;
  }

  const firstHue = sortedMembers[0]?.hue;
  const lastHue = sortedMembers.at(-1)?.hue;

  if (
    memberGroups.length > 1 &&
    firstHue !== undefined &&
    lastHue !== undefined &&
    firstHue + FULL_CIRCLE_DEGREES - lastHue <= HUE_TOLERANCE_DEGREES
  ) {
    memberGroups[0].push(...memberGroups.pop()!);
  }

  return memberGroups;
}

function getMostUsedColor(members: PaletteMember[]): string {
  const countByColor = new Map<string, number>();

  for (const member of members) {
    const opaqueColor = getOpaqueHexColor(member.value);
    countByColor.set(opaqueColor, (countByColor.get(opaqueColor) ?? 0) + 1);
  }

  let mostUsedColor = "";
  let highestCount = 0;

  for (const [color, count] of countByColor) {
    if (count <= highestCount) continue;

    mostUsedColor = color;
    highestCount = count;
  }

  return mostUsedColor;
}
