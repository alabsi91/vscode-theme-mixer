/**
 * Vscode-textmate's `Theme.match`, with no `vscode` import so it can be tested.
 *
 * Two things surprise people. A rule is picked per scope of the stack and the results merge, one rule for the foreground and
 * another for the font style. And more dot segments always beat parent scopes.
 */

const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;

interface ForegroundSource {
  color: string;
  ruleIndex: number;
}

/** Zero bits means the rule turns every style off, which is a real value. */
interface FontStyleSource {
  bits: number;
  ruleIndex: number;
}

export interface TokenColorMatchResult {
  foreground: string | null;
  foregroundRuleIndex: number | null;
  /** Empty when a rule turns every style off. Null when no rule sets one. */
  fontStyle: string | null;
  fontStyleRuleIndex: number | null;
}

export interface TokenColorMatcher {
  /** Outermost first: `["source.ts", "meta.block", "entity.name.function"]`. */
  matchScopeStack(scopeStack: readonly string[]): TokenColorMatchResult;
}

/**
 * Build a new one after editing any rule.
 *
 * @param tokenColorRules Straight off disk. Entries that are not rules are ignored.
 * @param defaultForeground The theme's `editor.foreground`.
 */
export function createTokenColorMatcher(
  tokenColorRules: readonly unknown[],
  defaultForeground: string | null = null
): TokenColorMatcher {
  const parsedTokenColorSelectors = parseTokenColorRules(tokenColorRules);
  sortSelectorsForInsertion(parsedTokenColorSelectors);

  const rootNode = createTrieNode({ scopeDepth: 0, parentScopes: [], foreground: null, fontStyle: null });
  for (const selector of parsedTokenColorSelectors) {
    insertSelector(rootNode, 0, selector.scope, selector);
  }

  const sortedRulesByScopeName = new Map<string, TrieRule[]>();

  function getSortedRules(scopeName: string): TrieRule[] {
    const cachedRules = sortedRulesByScopeName.get(scopeName);
    if (cachedRules) {
      return cachedRules;
    }

    const matchingTrieRules = getMatchingTrieRules(rootNode, scopeName);
    sortedRulesByScopeName.set(scopeName, matchingTrieRules);

    return matchingTrieRules;
  }

  return {
    matchScopeStack(scopeStack) {
      let foreground: ForegroundSource | null = null;
      let fontStyle: FontStyleSource | null = null;

      for (let level = 0; level < scopeStack.length; level++) {
        const ancestorScopes = scopeStack.slice(0, level).toReversed();
        const winningRule = getSortedRules(scopeStack[level]).find(rule =>
          isScopePathMatchingParentScopes(ancestorScopes, rule.parentScopes)
        );
        if (!winningRule) continue;

        if (winningRule.foreground) {
          foreground = winningRule.foreground;
        }

        if (winningRule.fontStyle) {
          fontStyle = winningRule.fontStyle;
        }
      }

      return {
        foreground: foreground ? foreground.color : defaultForeground,
        foregroundRuleIndex: foreground ? foreground.ruleIndex : null,
        fontStyle: fontStyle ? getFontStyleText(fontStyle.bits) : null,
        fontStyleRuleIndex: fontStyle ? fontStyle.ruleIndex : null,
      };
    },
  };
}

interface ThemeTokenColorRule {
  scope?: unknown;
  settings?: { foreground?: unknown; fontStyle?: unknown };
}

/** One scope selector of one rule. `parentScopes` runs from the nearest parent outward, or is null when there are none. */
interface ParsedTokenColorSelector {
  scope: string;
  parentScopes: string[] | null;
  ruleIndex: number;
  foreground: ForegroundSource | null;
  fontStyle: FontStyleSource | null;
}

function parseTokenColorRules(tokenColorRules: readonly unknown[]): ParsedTokenColorSelector[] {
  const parsedTokenColorSelectors: ParsedTokenColorSelector[] = [];

  for (const [ruleIndex, tokenColorRule] of tokenColorRules.entries()) {
    const rule = tokenColorRule as ThemeTokenColorRule | null;
    if (!rule || typeof rule !== "object" || !rule.settings || typeof rule.settings !== "object") continue;

    const foreground = createForegroundSource(rule.settings.foreground, ruleIndex);
    const fontStyle = createFontStyleSource(rule.settings.fontStyle, ruleIndex);

    for (const scopeSelector of getScopeSelectors(rule.scope)) {
      const scopeSegments = scopeSelector.trim().split(" ");
      const scope = scopeSegments.at(-1);

      // VS Code drops rules that name no scope.
      if (!scope) continue;

      const parentScopes = scopeSegments.length > 1 ? scopeSegments.slice(0, -1).toReversed() : null;

      parsedTokenColorSelectors.push({ scope, parentScopes, ruleIndex, foreground, fontStyle });
    }
  }

  return parsedTokenColorSelectors;
}

function getScopeSelectors(scope: unknown): string[] {
  if (Array.isArray(scope)) {
    return scope.filter(entry => typeof entry === "string");
  }

  if (typeof scope !== "string") {
    return [];
  }

  const scopeWithoutOuterCommas = scope.replace(/^,+/, "").replace(/,+$/, "");

  return scopeWithoutOuterCommas.split(",");
}

function createForegroundSource(foreground: unknown, ruleIndex: number): ForegroundSource | null {
  if (typeof foreground !== "string" || !isValidHexColor(foreground)) {
    return null;
  }

  return { color: foreground, ruleIndex };
}

// An empty string parses to zero bits. That is how a theme turns bold back off.
function createFontStyleSource(fontStyle: unknown, ruleIndex: number): FontStyleSource | null {
  if (typeof fontStyle !== "string") {
    return null;
  }

  let bits = 0;

  for (const word of fontStyle.split(" ")) {
    switch (word) {
      case "italic": {
        bits |= FONT_STYLE_ITALIC;
        break;
      }
      case "bold": {
        bits |= FONT_STYLE_BOLD;
        break;
      }
      case "underline": {
        bits |= FONT_STYLE_UNDERLINE;
        break;
      }
      case "strikethrough": {
        bits |= FONT_STYLE_STRIKETHROUGH;
        break;
      }
    }
  }

  return { bits, ruleIndex };
}

function isValidHexColor(color: string): boolean {
  return /^#[0-9a-f]{3,4}$/i.test(color) || /^#[0-9a-f]{6}$/i.test(color) || /^#[0-9a-f]{8}$/i.test(color);
}

function getFontStyleText(bits: number): string {
  const fontStyleWords: string[] = [];

  if (bits & FONT_STYLE_ITALIC) {
    fontStyleWords.push("italic");
  }

  if (bits & FONT_STYLE_BOLD) {
    fontStyleWords.push("bold");
  }

  if (bits & FONT_STYLE_UNDERLINE) {
    fontStyleWords.push("underline");
  }

  if (bits & FONT_STYLE_STRIKETHROUGH) {
    fontStyleWords.push("strikethrough");
  }

  return fontStyleWords.join(" ");
}

// vscode-textmate inserts by scope text, not array order. `entity` lands before `entity.name`, and the deeper node
// inherits what the shallower rule set.
function sortSelectorsForInsertion(parsedTokenColorSelectors: ParsedTokenColorSelector[]): void {
  parsedTokenColorSelectors.sort((left, right) => {
    const scopeOrder = compareStrings(left.scope, right.scope);
    if (scopeOrder !== 0) {
      return scopeOrder;
    }

    const parentOrder = compareStringArrays(left.parentScopes, right.parentScopes);
    if (parentOrder !== 0) {
      return parentOrder;
    }

    return left.ruleIndex - right.ruleIndex;
  });
}

interface TrieRule {
  /** How many dot segments the rule's own scope names. A higher number beats everything else. */
  scopeDepth: number;
  parentScopes: string[];
  foreground: ForegroundSource | null;
  fontStyle: FontStyleSource | null;
}

/** One dot segment of a scope. `entity.name` is the child `name` of the child `entity` of the root. */
interface TrieNode {
  /** For selectors that name no parents. */
  mainRule: TrieRule;
  rulesWithParentScopes: TrieRule[];
  childrenBySegment: Map<string, TrieNode>;
}

function createTrieNode(mainRule: TrieRule, rulesWithParentScopes: TrieRule[] = []): TrieNode {
  return { mainRule, rulesWithParentScopes, childrenBySegment: new Map() };
}

function cloneTrieRule(rule: TrieRule): TrieRule {
  return { ...rule };
}

function insertSelector(node: TrieNode, scopeDepth: number, remainingScope: string, selector: ParsedTokenColorSelector): void {
  if (remainingScope === "") {
    insertSelectorAtNode(node, scopeDepth, selector);
    return;
  }

  const dotIndex = remainingScope.indexOf(".");
  const segment = dotIndex === -1 ? remainingScope : remainingScope.slice(0, dotIndex);
  const remainingScopeAfterSegment = dotIndex === -1 ? "" : remainingScope.slice(dotIndex + 1);

  let child = node.childrenBySegment.get(segment);
  if (!child) {
    // A new node starts as a copy of its parent. That is how a deeper scope inherits a shallower rule.
    child = createTrieNode(
      cloneTrieRule(node.mainRule),
      node.rulesWithParentScopes.map(rule => cloneTrieRule(rule))
    );
    node.childrenBySegment.set(segment, child);
  }

  insertSelector(child, scopeDepth + 1, remainingScopeAfterSegment, selector);
}

function insertSelectorAtNode(node: TrieNode, scopeDepth: number, selector: ParsedTokenColorSelector): void {
  if (selector.parentScopes === null) {
    mergeSelectorIntoTrieRule(node.mainRule, scopeDepth, selector);
    return;
  }

  for (const rule of node.rulesWithParentScopes) {
    if (compareStringArrays(rule.parentScopes, selector.parentScopes) === 0) {
      mergeSelectorIntoTrieRule(rule, scopeDepth, selector);
      return;
    }
  }

  node.rulesWithParentScopes.push({
    scopeDepth,
    parentScopes: selector.parentScopes,
    foreground: selector.foreground ?? node.mainRule.foreground,
    fontStyle: selector.fontStyle ?? node.mainRule.fontStyle,
  });
}

function mergeSelectorIntoTrieRule(rule: TrieRule, scopeDepth: number, selector: ParsedTokenColorSelector): void {
  if (rule.scopeDepth <= scopeDepth) {
    rule.scopeDepth = scopeDepth;
  }

  if (selector.foreground) {
    rule.foreground = selector.foreground;
  }

  if (selector.fontStyle) {
    rule.fontStyle = selector.fontStyle;
  }
}

// The walk stops at the deepest node that exists. `entity.name` matches `entity.name.function`, `entity.name.func` does not.
function getMatchingTrieRules(node: TrieNode, remainingScope: string): TrieRule[] {
  if (remainingScope !== "") {
    const dotIndex = remainingScope.indexOf(".");
    const segment = dotIndex === -1 ? remainingScope : remainingScope.slice(0, dotIndex);
    const remainingScopeAfterSegment = dotIndex === -1 ? "" : remainingScope.slice(dotIndex + 1);

    const child = node.childrenBySegment.get(segment);
    if (child) {
      return getMatchingTrieRules(child, remainingScopeAfterSegment);
    }
  }

  const sortedTrieRules = [...node.rulesWithParentScopes, node.mainRule];
  sortedTrieRules.sort(compareTrieRulesBySpecificity);

  return sortedTrieRules;
}

function compareTrieRulesBySpecificity(left: TrieRule, right: TrieRule): number {
  if (left.scopeDepth !== right.scopeDepth) {
    return right.scopeDepth - left.scopeDepth;
  }

  let leftIndex = 0;
  let rightIndex = 0;

  // Walk both parent lists from the nearest parent outward. The longer parent scope wins. `meta.block` beats `meta`.
  while (true) {
    if (left.parentScopes[leftIndex] === ">") {
      leftIndex++;
    }

    if (right.parentScopes[rightIndex] === ">") {
      rightIndex++;
    }

    if (leftIndex >= left.parentScopes.length || rightIndex >= right.parentScopes.length) break;

    const lengthOrder = right.parentScopes[rightIndex].length - left.parentScopes[leftIndex].length;
    if (lengthOrder !== 0) {
      return lengthOrder;
    }

    leftIndex++;
    rightIndex++;
  }

  return right.parentScopes.length - left.parentScopes.length;
}

// A parent scope may skip over ancestors that do not match, unless a `>` in front of it demands the ancestor right there.
function isScopePathMatchingParentScopes(ancestorScopes: readonly string[], parentScopes: readonly string[]): boolean {
  if (parentScopes.length === 0) {
    return true;
  }

  let ancestorIndex = 0;

  for (let parentIndex = 0; parentIndex < parentScopes.length; parentIndex++) {
    let parentScope = parentScopes[parentIndex];
    let isMustMatchImmediately = false;

    if (parentScope === ">") {
      if (parentIndex === parentScopes.length - 1) {
        return false;
      }

      parentScope = parentScopes[++parentIndex];
      isMustMatchImmediately = true;
    }

    while (ancestorIndex < ancestorScopes.length && !isScopeMatchingSelector(ancestorScopes[ancestorIndex], parentScope)) {
      if (isMustMatchImmediately) {
        return false;
      }

      ancestorIndex++;
    }

    if (ancestorIndex >= ancestorScopes.length) {
      return false;
    }

    ancestorIndex++;
  }

  return true;
}

// `entity.name` matches `entity.name.function`. The prefix has to end on a dot.
function isScopeMatchingSelector(scopeName: string, selector: string): boolean {
  return selector === scopeName || (scopeName.startsWith(selector) && scopeName[selector.length] === ".");
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}

function compareStringArrays(left: readonly string[] | null, right: readonly string[] | null): number {
  if (left === null && right === null) {
    return 0;
  }

  if (!left) {
    return -1;
  }

  if (!right) {
    return 1;
  }

  if (left.length !== right.length) {
    return left.length - right.length;
  }

  for (const [index, element] of left.entries()) {
    const order = compareStrings(element, right[index]);
    if (order !== 0) {
      return order;
    }
  }

  return 0;
}
