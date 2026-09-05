import * as vscode from "vscode";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import { INITIAL, Registry, parseRawGrammar } from "vscode-textmate";

import type {
  IEmbeddedLanguagesMap,
  IGrammar,
  IGrammarConfiguration,
  IOnigLib,
  IRawGrammar,
  IToken,
  ITokenTypeMap,
  StateStack,
} from "vscode-textmate";

/** Where the build copies `onig.wasm` to. tsdown's `copy.to` is a directory, and this is the file inside it. */
export const ONIGURUMA_WASM_EXTENSION_PATH = "lib/onig.wasm";

/** The per-line limit VS Code uses. It is checked between regex matches. One bad line can overshoot it. */
const TOKENIZE_TIME_LIMIT_MILLISECONDS = 500;

const STANDARD_TOKEN_TYPE_NUMBER_BY_NAME: Record<string, number> = { other: 0, comment: 1, string: 2, regex: 3 };

export interface TextMateToken {
  text: string;
  range: vscode.Range;
  /** Innermost last. */
  scopes: string[];
}

export interface SemanticToken {
  tokenType: string;
  tokenModifiers: string[];
  range: vscode.Range;
}

/** Build one per activation and push it into `context.subscriptions`. */
export class TextMateTokenizer implements vscode.Disposable {
  private readonly extensionUri: vscode.Uri;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly lineStateCacheByDocumentUriText = new Map<string, DocumentLineStateCache>();
  private readonly grammarPromiseByLanguageId = new Map<string, Promise<IGrammar | null>>();

  private registry: Registry | null = null;
  private grammarContributions: GrammarContributionIndex | null = null;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri = extensionUri;

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(event => this.dropLineStateFromFirstChangedLine(event)),
      vscode.workspace.onDidCloseTextDocument(document => this.lineStateCacheByDocumentUriText.delete(document.uri.toString())),
      vscode.extensions.onDidChange(() => this.forgetGrammars())
    );
  }

  /**
   * The token at a position. A position past the end of a line gives the last token on that line.
   *
   * @returns Null when there is no grammar, the grammar is broken, or tokenizing hit its time limit. Nothing is guessed.
   */
  async getTokenAtPosition(document: vscode.TextDocument, position: vscode.Position): Promise<TextMateToken | null> {
    try {
      if (position.line >= document.lineCount) {
        return null;
      }

      const grammar = await this.loadGrammarForLanguage(document.languageId);
      if (!grammar) {
        return null;
      }

      const lineTokens = this.tokenizeUpToLine(document, grammar, position.line);
      if (!lineTokens) {
        return null;
      }

      const tokenContainingPosition = lineTokens.find(
        candidate => position.character >= candidate.startIndex && position.character < candidate.endIndex
      );
      const token = tokenContainingPosition ?? lineTokens.at(-1);
      if (!token) {
        return null;
      }

      const lineText = document.lineAt(position.line).text;

      // vscode-textmate appends a newline before tokenizing. The last token counts it in.
      const tokenEndCharacter = Math.min(token.endIndex, lineText.length);

      return {
        text: lineText.slice(token.startIndex, tokenEndCharacter),
        range: new vscode.Range(position.line, token.startIndex, position.line, tokenEndCharacter),
        scopes: token.scopes,
      };
    } catch {
      return null;
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }

    this.disposables.length = 0;
    this.forgetGrammars();
  }

  private forgetGrammars(): void {
    this.registry?.dispose();
    this.registry = null;
    this.grammarContributions = null;
    this.grammarPromiseByLanguageId.clear();
    this.lineStateCacheByDocumentUriText.clear();
  }

  private getRegistry(): Registry {
    if (this.registry) {
      return this.registry;
    }

    const grammarContributions = indexGrammarContributions();
    this.grammarContributions = grammarContributions;

    this.registry = new Registry({
      onigLib: loadOnigurumaLibrary(this.extensionUri),
      loadGrammar: scopeName => readContributedGrammar(grammarContributions, scopeName),
      getInjections: scopeName => getInjectingScopeNames(grammarContributions, scopeName),
    });

    return this.registry;
  }

  private loadGrammarForLanguage(languageId: string): Promise<IGrammar | null> {
    const cachedGrammarPromise = this.grammarPromiseByLanguageId.get(languageId);
    if (cachedGrammarPromise) {
      return cachedGrammarPromise;
    }

    const registry = this.getRegistry();
    const grammarContributions = this.grammarContributions;
    if (!grammarContributions) {
      return Promise.resolve(null);
    }

    const scopeName = grammarContributions.scopeNameByLanguageId.get(languageId);
    if (!scopeName) {
      return Promise.resolve(null);
    }

    const contribution = grammarContributions.contributionByScopeName.get(scopeName);
    if (!contribution) {
      return Promise.resolve(null);
    }

    const grammarConfig = createGrammarConfig(grammarContributions, contribution);

    const grammarPromise = registry
      .loadGrammarWithConfiguration(scopeName, getLocalLanguageNumber(languageId), grammarConfig)
      .catch(() => null);

    this.grammarPromiseByLanguageId.set(languageId, grammarPromise);

    return grammarPromise;
  }

  private getLineStateCache(document: vscode.TextDocument): DocumentLineStateCache {
    const documentUriText = document.uri.toString();
    const cache = this.lineStateCacheByDocumentUriText.get(documentUriText);

    // A language change means every cached state belongs to the wrong grammar.
    if (cache && cache.languageId === document.languageId) {
      return cache;
    }

    const freshCache: DocumentLineStateCache = { languageId: document.languageId, stateStackAfterLine: [] };
    this.lineStateCacheByDocumentUriText.set(documentUriText, freshCache);

    return freshCache;
  }

  // Grammar state runs from one line into the next. The scopes on a line are only right after every line above it.
  // Null when the time limit stopped a line short.
  private tokenizeUpToLine(document: vscode.TextDocument, grammar: IGrammar, wantedLineIndex: number): IToken[] | null {
    const stateStackAfterLine = this.getLineStateCache(document).stateStackAfterLine;

    const firstLineToTokenize = Math.min(stateStackAfterLine.length, wantedLineIndex);
    let previousStateStack: StateStack = firstLineToTokenize === 0 ? INITIAL : stateStackAfterLine[firstLineToTokenize - 1];

    for (let lineIndex = firstLineToTokenize; lineIndex < wantedLineIndex; lineIndex++) {
      const lineText = document.lineAt(lineIndex).text;
      const result = grammar.tokenizeLine(lineText, previousStateStack, TOKENIZE_TIME_LIMIT_MILLISECONDS);

      if (result.stoppedEarly) {
        return null;
      }

      previousStateStack = result.ruleStack;
      stateStackAfterLine[lineIndex] = previousStateStack;
    }

    const wantedLineText = document.lineAt(wantedLineIndex).text;
    const wantedLineResult = grammar.tokenizeLine(wantedLineText, previousStateStack, TOKENIZE_TIME_LIMIT_MILLISECONDS);

    if (wantedLineResult.stoppedEarly) {
      return null;
    }

    stateStackAfterLine[wantedLineIndex] = wantedLineResult.ruleStack;

    return wantedLineResult.tokens;
  }

  private dropLineStateFromFirstChangedLine(event: vscode.TextDocumentChangeEvent): void {
    const cache = this.lineStateCacheByDocumentUriText.get(event.document.uri.toString());
    if (!cache) return;

    let firstChangedLineIndex = cache.stateStackAfterLine.length;
    for (const change of event.contentChanges) {
      firstChangedLineIndex = Math.min(firstChangedLineIndex, change.range.start.line);
    }

    cache.stateStackAfterLine.length = firstChangedLineIndex;
  }
}

/** A language server that provides these colors the token itself. Tell the user, or they edit a rule and see no change. */
export async function getSemanticTokenAtPosition(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<SemanticToken | null> {
  const semanticTokens = await readDocumentSemanticTokens(document);
  if (!semanticTokens) {
    return null;
  }

  return findSemanticTokenAtPosition(semanticTokens, position);
}

interface DocumentLineStateCache {
  languageId: string;
  /** The grammar state after each line, starting at line 0. Cut back to the first edited line on every change. */
  stateStackAfterLine: StateStack[];
}

interface ContributedGrammarEntry {
  language?: string;
  scopeName?: string;
  path?: string;
  injectTo?: string[];
  embeddedLanguages?: Record<string, string>;
  tokenTypes?: Record<string, string>;
  balancedBracketScopes?: string[];
  unbalancedBracketScopes?: string[];
}

interface ExtensionPackageJson {
  contributes?: { grammars?: ContributedGrammarEntry[] };
}

interface GrammarContribution {
  scopeName: string;
  grammarFileUri: vscode.Uri;
  embeddedLanguageIdByScopeName: Record<string, string>;
  standardTokenTypeNameByScopeName: Record<string, string>;
  balancedBracketSelectors: string[];
  unbalancedBracketSelectors: string[];
}

interface GrammarContributionIndex {
  contributionByScopeName: Map<string, GrammarContribution>;
  /** A grammar with no `language` is injection-only and is not in here. */
  scopeNameByLanguageId: Map<string, string>;
  injectingScopeNamesByTargetScopeName: Map<string, string[]>;
}

function indexGrammarContributions(): GrammarContributionIndex {
  const contributionByScopeName = new Map<string, GrammarContribution>();
  const scopeNameByLanguageId = new Map<string, string>();
  const injectingScopeNamesByTargetScopeName = new Map<string, string[]>();

  for (const extension of vscode.extensions.all) {
    const packageJson = extension.packageJSON as ExtensionPackageJson;

    const grammarEntries = packageJson.contributes?.grammars;
    if (!Array.isArray(grammarEntries)) continue;

    for (const entry of grammarEntries) {
      if (typeof entry?.scopeName !== "string" || typeof entry.path !== "string") continue;

      contributionByScopeName.set(entry.scopeName, {
        scopeName: entry.scopeName,
        grammarFileUri: vscode.Uri.joinPath(extension.extensionUri, entry.path),
        embeddedLanguageIdByScopeName: entry.embeddedLanguages ?? {},
        standardTokenTypeNameByScopeName: entry.tokenTypes ?? {},
        balancedBracketSelectors: entry.balancedBracketScopes ?? ["*"],
        unbalancedBracketSelectors: entry.unbalancedBracketScopes ?? [],
      });

      if (typeof entry.language === "string") {
        scopeNameByLanguageId.set(entry.language, entry.scopeName);
      }

      const targetScopeNames = entry.injectTo ?? [];

      for (const targetScopeName of targetScopeNames) {
        const injectingScopeNames = injectingScopeNamesByTargetScopeName.get(targetScopeName) ?? [];
        injectingScopeNames.push(entry.scopeName);
        injectingScopeNamesByTargetScopeName.set(targetScopeName, injectingScopeNames);
      }
    }
  }

  return { contributionByScopeName, scopeNameByLanguageId, injectingScopeNamesByTargetScopeName };
}

// A grammar registered against `text` injects into `text.html.markdown` too. Every dot-prefix has to be looked up.
function getInjectingScopeNames(grammarContributions: GrammarContributionIndex, scopeName: string): string[] {
  const scopeSegments = scopeName.split(".");
  const injectingScopeNames: string[] = [];

  for (let segmentCount = 1; segmentCount <= scopeSegments.length; segmentCount++) {
    const scopePrefix = scopeSegments.slice(0, segmentCount).join(".");
    injectingScopeNames.push(...(grammarContributions.injectingScopeNamesByTargetScopeName.get(scopePrefix) ?? []));
  }

  return injectingScopeNames;
}

async function readContributedGrammar(
  grammarContributions: GrammarContributionIndex,
  scopeName: string
): Promise<IRawGrammar | null> {
  const contribution = grammarContributions.contributionByScopeName.get(scopeName);
  if (!contribution) {
    return null;
  }

  try {
    const fileContents = await vscode.workspace.fs.readFile(contribution.grammarFileUri);
    const fileText = new TextDecoder().decode(fileContents);

    return parseRawGrammar(fileText, contribution.grammarFileUri.fsPath);
  } catch {
    return null;
  }
}

// The raw package.json values look right and are silently ignored. vscode-textmate wants numbers.
function createGrammarConfig(
  grammarContributions: GrammarContributionIndex,
  contribution: GrammarContribution
): IGrammarConfiguration {
  const embeddedLanguageIdByScopeName = {
    ...collectInjectedEmbeddedLanguages(grammarContributions, contribution.scopeName),
    ...contribution.embeddedLanguageIdByScopeName,
  };

  return {
    embeddedLanguages: createEmbeddedLanguageNumbers(embeddedLanguageIdByScopeName),
    tokenTypes: createStandardTokenTypeNumbers(contribution.standardTokenTypeNameByScopeName),
    balancedBracketSelectors: contribution.balancedBracketSelectors,
    unbalancedBracketSelectors: contribution.unbalancedBracketSelectors,
  };
}

// An injecting grammar brings its own embedded languages. Without them the injected regions go untokenized.
function collectInjectedEmbeddedLanguages(
  grammarContributions: GrammarContributionIndex,
  scopeName: string
): Record<string, string> {
  const embeddedLanguageIdByScopeName: Record<string, string> = {};
  const injectingScopeNames = grammarContributions.injectingScopeNamesByTargetScopeName.get(scopeName) ?? [];

  for (const injectingScopeName of injectingScopeNames) {
    const injectingContribution = grammarContributions.contributionByScopeName.get(injectingScopeName);

    if (injectingContribution) {
      Object.assign(embeddedLanguageIdByScopeName, injectingContribution.embeddedLanguageIdByScopeName);
    }
  }

  return embeddedLanguageIdByScopeName;
}

function createEmbeddedLanguageNumbers(embeddedLanguageIdByScopeName: Record<string, string>): IEmbeddedLanguagesMap {
  const languageNumberByScopeName: IEmbeddedLanguagesMap = {};

  for (const [scopeName, languageId] of Object.entries(embeddedLanguageIdByScopeName)) {
    languageNumberByScopeName[scopeName] = getLocalLanguageNumber(languageId);
  }

  return languageNumberByScopeName;
}

function createStandardTokenTypeNumbers(standardTokenTypeNameByScopeName: Record<string, string>): ITokenTypeMap {
  const tokenTypeNumberByScopeName: ITokenTypeMap = {};

  for (const [scopeName, tokenTypeName] of Object.entries(standardTokenTypeNameByScopeName)) {
    const tokenTypeNumber = STANDARD_TOKEN_TYPE_NUMBER_BY_NAME[tokenTypeName];

    if (tokenTypeNumber !== undefined) {
      tokenTypeNumberByScopeName[scopeName] = tokenTypeNumber;
    }
  }

  return tokenTypeNumberByScopeName;
}

// VS Code's own language numbers cannot be read from an extension. These are ours, and nothing depends on matching.
const localLanguageNumberByLanguageId = new Map<string, number>();

function getLocalLanguageNumber(languageId: string): number {
  const knownLanguageNumber = localLanguageNumberByLanguageId.get(languageId);
  if (knownLanguageNumber !== undefined) {
    return knownLanguageNumber;
  }

  // Language number 0 is reserved.
  const localLanguageNumber = localLanguageNumberByLanguageId.size + 1;
  localLanguageNumberByLanguageId.set(languageId, localLanguageNumber);

  return localLanguageNumber;
}

// `loadWASM` throws on a second call in the same extension host. The promise is kept and handed out again.
let onigurumaLibraryPromise: Promise<IOnigLib> | null = null;

function loadOnigurumaLibrary(extensionUri: vscode.Uri): Promise<IOnigLib> {
  onigurumaLibraryPromise ??= readAndLoadOnigurumaWasm(extensionUri);
  return onigurumaLibraryPromise;
}

async function readAndLoadOnigurumaWasm(extensionUri: vscode.Uri): Promise<IOnigLib> {
  const wasmFileUri = vscode.Uri.joinPath(extensionUri, ONIGURUMA_WASM_EXTENSION_PATH);
  const wasmBytes = await vscode.workspace.fs.readFile(wasmFileUri);

  await loadWASM(wasmBytes);

  return { createOnigScanner, createOnigString };
}

interface DocumentSemanticTokens {
  legend: vscode.SemanticTokensLegend;
  tokens: vscode.SemanticTokens;
}

// Reading semantic tokens tokenizes the whole document. One answer per document version is kept.
let semanticTokensCacheKey = "";
let semanticTokensCachePromise: Promise<DocumentSemanticTokens | null> | null = null;

function readDocumentSemanticTokens(document: vscode.TextDocument): Promise<DocumentSemanticTokens | null> {
  const cacheKey = `${document.uri.toString()}@${document.version}`;

  if (semanticTokensCacheKey !== cacheKey || !semanticTokensCachePromise) {
    semanticTokensCacheKey = cacheKey;

    // A null must not be kept. The language server may still be starting up.
    semanticTokensCachePromise = requestDocumentSemanticTokens(document).then(semanticTokens => {
      if (!semanticTokens && semanticTokensCacheKey === cacheKey) {
        semanticTokensCacheKey = "";
        semanticTokensCachePromise = null;
      }

      return semanticTokens;
    });
  }

  return semanticTokensCachePromise;
}

async function requestDocumentSemanticTokens(document: vscode.TextDocument): Promise<DocumentSemanticTokens | null> {
  try {
    const legend = await vscode.commands.executeCommand<vscode.SemanticTokensLegend | undefined>(
      "vscode.provideDocumentSemanticTokensLegend",
      document.uri
    );
    if (!legend) {
      return null;
    }

    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens | undefined>(
      "vscode.provideDocumentSemanticTokens",
      document.uri
    );
    if (!tokens) {
      return null;
    }

    return { legend, tokens };
  } catch {
    return null;
  }
}

// Each token takes five numbers. The first two are deltas from the previous token. The start column resets on a new line.
function findSemanticTokenAtPosition(semanticTokens: DocumentSemanticTokens, position: vscode.Position): SemanticToken | null {
  const tokenData = semanticTokens.tokens.data;

  let lineIndex = 0;
  let startCharacter = 0;

  for (let dataIndex = 0; dataIndex + 4 < tokenData.length; dataIndex += 5) {
    const deltaLine = tokenData[dataIndex];
    const deltaStartCharacter = tokenData[dataIndex + 1];
    const tokenLength = tokenData[dataIndex + 2];
    const tokenTypeIndex = tokenData[dataIndex + 3];
    const tokenModifierBits = tokenData[dataIndex + 4];

    lineIndex += deltaLine;
    startCharacter = deltaLine === 0 ? startCharacter + deltaStartCharacter : deltaStartCharacter;

    if (lineIndex > position.line) {
      return null;
    }

    const isPositionInToken =
      lineIndex === position.line && position.character >= startCharacter && position.character < startCharacter + tokenLength;
    if (!isPositionInToken) continue;

    const tokenType = semanticTokens.legend.tokenTypes[tokenTypeIndex];
    if (tokenType === undefined) {
      return null;
    }

    const tokenModifiers = semanticTokens.legend.tokenModifiers.filter(
      (_modifierName, modifierIndex) => (tokenModifierBits & (1 << modifierIndex)) !== 0
    );

    return {
      tokenType,
      tokenModifiers,
      range: new vscode.Range(lineIndex, startCharacter, lineIndex, startCharacter + tokenLength),
    };
  }

  return null;
}
