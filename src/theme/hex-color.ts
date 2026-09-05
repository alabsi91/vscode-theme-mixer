// Shared by the extension and the webview. Nothing here may import vscode or node.

export const HEX_COLOR_PATTERN = /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i;

const MAXIMUM_CHANNEL_VALUE = 255;

export interface HexColorChannels {
  red: number;
  green: number;
  blue: number;
  /** Two lowercase hex digits, or an empty string when the color has no alpha. */
  alphaHexDigits: string;
}

export function expandShorthandHexColor(value: string): string {
  const hexDigits = value.slice(1);
  if (hexDigits.length > 4) {
    return value;
  }

  return `#${hexDigits.replace(/./g, digit => digit + digit)}`;
}

/** Null when the value is not a hex color. */
export function parseHexColor(value: string): HexColorChannels | null {
  if (!HEX_COLOR_PATTERN.test(value)) {
    return null;
  }

  const hexDigits = expandShorthandHexColor(value).slice(1).toLowerCase();

  return {
    red: Number.parseInt(hexDigits.slice(0, 2), 16),
    green: Number.parseInt(hexDigits.slice(2, 4), 16),
    blue: Number.parseInt(hexDigits.slice(4, 6), 16),
    alphaHexDigits: hexDigits.slice(6),
  };
}

/** Lowercase, 6 or 8 digits. Channels are rounded and clamped to 0..255. */
export function formatHexColor(channels: HexColorChannels): string {
  const rgbHexDigits = [channels.red, channels.green, channels.blue]
    .map(channel => Math.round(clampColorChannel(channel)).toString(16).padStart(2, "0"))
    .join("");

  return `#${rgbHexDigits}${channels.alphaHexDigits}`;
}

export function clampColorChannel(channel: number): number {
  return Math.min(MAXIMUM_CHANNEL_VALUE, Math.max(0, channel));
}
