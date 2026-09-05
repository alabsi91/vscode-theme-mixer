import { HEX_COLOR_PATTERN, expandShorthandHexColor } from "../src/theme/hex-color.ts";

/** Dragging the picker fires continuously, and every send rewrites a theme file on disk. */
const COLOR_CHANGE_INTERVAL_MS = 120;

// The picker lowercases whatever it is given. Match that, or every comparison against it fails.
export function getSwatchValue(value: string | null): string {
  if (!value || !HEX_COLOR_PATTERN.test(value)) {
    return "#000000";
  }

  const hexDigits = expandShorthandHexColor(value).slice(1).toLowerCase();

  return `#${hexDigits.slice(0, 6)}`;
}

// The picker drops alpha. A CSS color name is left alone rather than expanded into invented hex digits.
export function getColorWithCurrentAlpha(currentValue: string | null | undefined, pickedValue: string): string {
  if (!currentValue || !HEX_COLOR_PATTERN.test(currentValue)) {
    return pickedValue;
  }

  const expandedValue = expandShorthandHexColor(currentValue);
  if (expandedValue.length !== 9) {
    return pickedValue;
  }

  // Many keys default to fully transparent. Keeping that alpha would store the pick as invisible.
  const alphaHexDigits = expandedValue.slice(7);
  if (alphaHexDigits === "00") {
    return pickedValue;
  }

  return pickedValue + alphaHexDigits;
}

/** Sends the first change at once, then holds what follows for a moment. The newest value per key wins. */
export interface ThrottledSender<Key, Value> {
  send(key: Key, value: Value): void;
  hasQueuedChange(key: Key): boolean;
  clearQueuedChanges(): void;
}

export function createThrottledSender<Key, Value>(sendOne: (key: Key, value: Value) => void): ThrottledSender<Key, Value> {
  const queuedValueByKey = new Map<Key, Value>();

  let timer: ReturnType<typeof setInterval> | undefined;

  function flush(): void {
    for (const [key, value] of queuedValueByKey) {
      sendOne(key, value);
    }

    queuedValueByKey.clear();
  }

  return {
    send(key, value) {
      queuedValueByKey.set(key, value);

      if (timer !== undefined) return;

      flush();

      timer = setInterval(() => {
        if (queuedValueByKey.size > 0) {
          flush();
          return;
        }

        clearInterval(timer);
        timer = undefined;
      }, COLOR_CHANGE_INTERVAL_MS);
    },

    hasQueuedChange(key) {
      return queuedValueByKey.has(key);
    },

    clearQueuedChanges() {
      queuedValueByKey.clear();
    },
  };
}
