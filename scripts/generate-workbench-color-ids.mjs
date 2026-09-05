// Builds data/workbench-color-ids.json from the VS Code source.
//
//   node scripts/generate-workbench-color-ids.mjs
//
// There is no runtime API and no npm package that lists the themeable workbench colors, and their
// defaults are transforms rather than literals. So this downloads the pinned VS Code source, bundles
// every file that registers a color, runs the bundle under DOM stubs, and reads the color registry.
//
// Run it by hand. The result is checked into the repo and the extension imports the JSON.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

/** The VS Code release that this list is generated from. Bump it by hand, never automatically. */
const VSCODE_SOURCE_TAG = "1.136.1";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const outputPath = path.join(repositoryRoot, "data/workbench-color-ids.json");
const workDirectory = path.join(repositoryRoot, "node_modules/.cache/vscode-source", VSCODE_SOURCE_TAG);

const sourceRoot = path.join(workDirectory, "src");
const bundledExtensionsRoot = path.join(workDirectory, "extensions");

/** The theme types that VS Code resolves defaults for. These are the values of its own `ColorScheme` enum. */
const THEME_TYPES = ["dark", "light", "hcDark", "hcLight"];

const vscodeSourcePlugin = {
  name: "vscode-source",
  setup(build) {
    // Stylesheets, fonts and images cannot affect a color default.
    const assetPattern = /\.(css|ttf|svg|png|woff2?|gif|jpe?g|mp3|wasm)(\?.*)?$/;
    build.onResolve({ filter: assetPattern }, args => ({ path: args.path, namespace: "ignored-asset" }));
    build.onLoad({ filter: /.*/, namespace: "ignored-asset" }, () => ({ contents: "", loader: "js" }));

    // VS Code imports its own TypeScript files with a .js extension.
    build.onResolve({ filter: /\.js$/ }, args => {
      if (!args.path.startsWith(".")) {
        return undefined;
      }

      const asTypeScript = path.resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
      return existsSync(asTypeScript) ? { path: asTypeScript } : undefined;
    });
  },
};

downloadVscodeSource();

const bundlePath = await bundleColorRegistry();

installDomStubs();

await import(`file://${bundlePath}`);

const colorRegistry = globalThis.__colorRegistry;
const Color = globalThis.__Color;

for (const contribution of readBundledExtensionColorContributions()) {
  colorRegistry.registerColor(contribution.id, contribution.defaults, contribution.description);
}

const themesByType = Object.fromEntries(THEME_TYPES.map(themeType => [themeType, createDefaultsOnlyTheme(themeType)]));

const generatedColors = colorRegistry.getColors().map(contribution => {
  const defaultsByThemeType = {};
  for (const themeType of THEME_TYPES) {
    const resolvedColor = colorRegistry.resolveDefaultColor(contribution.id, themesByType[themeType]);
    defaultsByThemeType[themeType] = resolvedColor ? Color.Format.CSS.formatHexA(resolvedColor, true) : null;
  }

  return {
    id: contribution.id,
    category: getCategoryFromColorId(contribution.id),
    description: contribution.description,
    defaults: defaultsByThemeType,
    needsTransparency: contribution.needsTransparency,
    deprecationMessage: contribution.deprecationMessage ?? null,
  };
});

generatedColors.sort((first, second) => first.id.localeCompare(second.id));

failOnDisappearedColorIds(generatedColors);

const colorIdsDocument = { vscodeSourceTag: VSCODE_SOURCE_TAG, colors: generatedColors };
writeFileSync(outputPath, `${JSON.stringify(colorIdsDocument, null, 2)}\n`);

const colorsWithoutAnyDefault = generatedColors.filter(color =>
  THEME_TYPES.every(themeType => color.defaults[themeType] === null)
);

console.error(`${generatedColors.length} color ids from VS Code ${VSCODE_SOURCE_TAG} -> ${outputPath}`);
console.error(`${colorsWithoutAnyDefault.length} of them have no default in any theme type, which is expected`);

// The bundled workbench modules leave timers behind and Node would hang on them.
process.exit(0);

function downloadVscodeSource() {
  if (existsSync(sourceRoot) && existsSync(bundledExtensionsRoot)) return;

  mkdirSync(workDirectory, { recursive: true });

  const tarballPath = path.join(workDirectory, "source.tar.gz");
  if (!existsSync(tarballPath)) {
    console.error(`downloading the VS Code ${VSCODE_SOURCE_TAG} source`);

    // curl creates the output file before the download finishes. A 404 or a dropped connection would
    // leave a truncated file behind, and the check above would then skip the download forever. So
    // download under a scratch name and only claim the cached name once curl succeeded.
    const partialTarballPath = `${tarballPath}.partial`;
    const tarballUrl = `https://codeload.github.com/microsoft/vscode/tar.gz/refs/tags/${VSCODE_SOURCE_TAG}`;

    execFileSync("curl", ["-sSL", "--fail", "-o", partialTarballPath, tarballUrl], { stdio: ["ignore", "ignore", "inherit"] });
    renameSync(partialTarballPath, tarballPath);
  }

  // Extracting every bundled extension would cost hundreds of megabytes of grammars and snippets.
  // Only the manifests are needed. Naming them one by one also avoids a wildcard flag that GNU tar
  // and BSD tar spell differently.
  const tarballEntries = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .trim()
    .split("\n");

  const manifestPattern = /^vscode-[^/]+\/extensions\/[^/]+\/package(\.nls)?\.json$/;
  const extensionManifestEntries = tarballEntries.filter(entry => manifestPattern.test(entry));

  console.error("extracting");
  const sourceEntry = `vscode-${VSCODE_SOURCE_TAG}/src`;
  const extractArguments = ["-xzf", tarballPath, "-C", workDirectory, "--strip-components=1", sourceEntry];
  execFileSync("tar", [...extractArguments, ...extensionManifestEntries]);
}

/**
 * Writes the entry that pulls in every file registering a color, then bundles it.
 *
 * Importing a file is not always enough. `terminalColorRegistry.ts` and `debugColors.ts` register their colors inside an exported
 * `registerColors()` that the workbench calls at startup. Missing that call loses the 16 `terminal.ansi*` ids and 26 debug ids.
 */
async function bundleColorRegistry() {
  const filesThatCallRegisterColor = getFilePathsContaining("registerColor(", sourceRoot).filter(filePath => {
    const isColorRegistryItself = filePath.endsWith("colorUtils.ts");
    const isTest = filePath.includes("/test/") || filePath.endsWith(".test.ts");
    return !isColorRegistryItself && !isTest;
  });

  const filesThatExportRegisterColors = getFilePathsContaining("export function registerColors", sourceRoot).filter(
    filePath => !filePath.includes("/test/")
  );

  const importStatements = filesThatCallRegisterColor.map(filePath => `import ${JSON.stringify(filePath)};`);

  const invokeStatements = filesThatExportRegisterColors.flatMap((filePath, index) => [
    `import * as deferredColorModule${index} from ${JSON.stringify(filePath)};`,
    `deferredColorModule${index}.registerColors();`,
  ]);

  const colorUtilsPath = path.join(sourceRoot, "vs/platform/theme/common/colorUtils.ts");
  const colorPath = path.join(sourceRoot, "vs/base/common/color.ts");
  const registryPath = path.join(sourceRoot, "vs/platform/registry/common/platform.ts");

  const entryPath = path.join(workDirectory, "entry.generated.ts");
  writeFileSync(
    entryPath,
    [
      ...importStatements,
      `import { Extensions } from ${JSON.stringify(colorUtilsPath)};`,
      `import { Color } from ${JSON.stringify(colorPath)};`,
      `import { Registry } from ${JSON.stringify(registryPath)};`,
      ...invokeStatements,
      `globalThis.__colorRegistry = Registry.as(Extensions.ColorContribution);`,
      `globalThis.__Color = Color;`,
    ].join("\n")
  );

  const generatedBundlePath = path.join(workDirectory, "bundle.mjs");

  console.error(`bundling ${filesThatCallRegisterColor.length} source files`);
  await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    outfile: generatedBundlePath,
    format: "esm",
    platform: "neutral",
    mainFields: ["module", "main"],
    conditions: ["import"],
    plugins: [vscodeSourcePlugin],
    tsconfigRaw: { compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false } },
    logLevel: "warning",
  });

  return generatedBundlePath;
}

function getFilePathsContaining(searchText, searchRoot) {
  return execFileSync("grep", ["-rlF", searchText, searchRoot, "--include=*.ts"], { encoding: "utf8" }).trim().split("\n");
}

/**
 * Colors contributed by the extensions that ship inside VS Code, such as `gitDecoration.*`.
 *
 * They live in `contributes.colors` of an extension manifest instead of the source, and their high contrast defaults fall back to
 * the plain dark and light ones.
 */
function readBundledExtensionColorContributions() {
  const colorContributions = [];

  const extensionDirectoryNames = execFileSync("ls", [bundledExtensionsRoot], { encoding: "utf8" }).trim().split("\n");

  for (const directoryName of extensionDirectoryNames) {
    const manifestPath = path.join(bundledExtensionsRoot, directoryName, "package.json");
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const contributedColors = manifest.contributes?.colors;
    if (!Array.isArray(contributedColors)) continue;

    const translationsByKey = readExtensionTranslations(path.join(bundledExtensionsRoot, directoryName));

    for (const color of contributedColors) {
      const defaults = color.defaults ?? {};
      colorContributions.push({
        id: color.id,
        description: getTranslatedDescription(color.description, translationsByKey),
        defaults: {
          dark: defaults.dark ?? null,
          light: defaults.light ?? null,
          hcDark: defaults.highContrast ?? defaults.dark ?? null,
          hcLight: defaults.highContrastLight ?? defaults.light ?? null,
        },
      });
    }
  }

  return colorContributions;
}

function readExtensionTranslations(extensionDirectory) {
  const translationsPath = path.join(extensionDirectory, "package.nls.json");
  if (existsSync(translationsPath)) {
    return JSON.parse(readFileSync(translationsPath, "utf8"));
  }

  return {};
}

function getTranslatedDescription(description, translationsByKey) {
  const placeholder = /^%(.+)%$/.exec(description ?? "");
  if (!placeholder) {
    return description ?? "";
  }

  const translation = translationsByKey[placeholder[1]];
  if (typeof translation === "string") {
    return translation;
  }

  // Newer manifests wrap a translation as `{ message, comment }`.
  return translation?.message ?? description;
}

/** A theme that answers every color with its registered default. Those defaults are what the output stores. */
function createDefaultsOnlyTheme(themeType) {
  const theme = {
    type: themeType,
    label: themeType,
    getColor: id => colorRegistry.resolveDefaultColor(id, theme),
    defines: id => colorRegistry.resolveDefaultColor(id, theme) !== undefined,
    getTokenStyleMetadata: () => undefined,
    semanticHighlighting: false,
    tokenColorMap: [],
  };

  return theme;
}

function getCategoryFromColorId(colorId) {
  const firstDotIndex = colorId.indexOf(".");
  return firstDotIndex === -1 ? colorId : colorId.slice(0, firstDotIndex);
}

/**
 * Stops the generator when the new dump lost ids the checked-in one had.
 *
 * A short list is worse than no list. It looks like a clean run and silently drops colors from every theme that the extension
 * writes.
 */
function failOnDisappearedColorIds(generatedColors) {
  if (!existsSync(outputPath)) return;

  const previousColorIdsDocument = JSON.parse(readFileSync(outputPath, "utf8"));
  const generatedIds = new Set(generatedColors.map(color => color.id));
  const disappearedIds = previousColorIdsDocument.colors.map(color => color.id).filter(id => !generatedIds.has(id));

  if (disappearedIds.length > 0) {
    const disappearedIdListing = disappearedIds.join("\n  ");
    throw new Error(
      `${disappearedIds.length} color ids present in ${outputPath} are missing from this run:\n  ${disappearedIdListing}\n` +
        `Extraction is broken, or VS Code ${VSCODE_SOURCE_TAG} removed them. Do not check in the short list.`
    );
  }
}

function installDomStubs() {
  // The bundled workbench files expect a browser. None of this changes a color. It only has to exist
  // while the modules run.
  const noop = () => undefined;
  const fakeElement = new Proxy(
    {},
    {
      get: (target, key) => (key === "style" || key === "classList" || key === "dataset" ? fakeElement : noop),
      set: () => true,
    }
  );

  globalThis._VSCODE_FILE_ROOT = "file:///vscode/out/";
  globalThis.self = globalThis;
  globalThis.window = globalThis;
  globalThis.location = { href: "http://localhost/", hash: "", search: "", protocol: "http:" };
  globalThis.document = new Proxy(
    {},
    {
      get: (target, key) => {
        if (key === "location") return globalThis.location;
        if (key === "body" || key === "head" || key === "documentElement") return fakeElement;
        if (key === "createElement" || key === "querySelector" || key === "getElementById") return () => fakeElement;
        return noop;
      },
    }
  );
  globalThis.matchMedia = () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop });
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.requestAnimationFrame = callback => setTimeout(callback, 0);
  globalThis.CSS = { supports: () => false, escape: value => value };
  globalThis.getComputedStyle = () => fakeElement;
  globalThis.addEventListener = noop;
  globalThis.removeEventListener = noop;
  globalThis.dispatchEvent = noop;
  globalThis.customElements = { get: () => undefined, define: noop, whenDefined: () => Promise.resolve() };

  class FakeDomClass {
    constructor(type) {
      this.type = type;
    }
    preventDefault() {}
    stopPropagation() {}
  }

  const domClassNames = [
    "Event",
    "UIEvent",
    "MouseEvent",
    "KeyboardEvent",
    "PointerEvent",
    "FocusEvent",
    "DragEvent",
    "WheelEvent",
    "CustomEvent",
    "InputEvent",
    "ClipboardEvent",
    "CompositionEvent",
    "TouchEvent",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLDivElement",
    "HTMLInputElement",
    "HTMLAnchorElement",
    "HTMLTextAreaElement",
    "HTMLCanvasElement",
    "HTMLImageElement",
    "HTMLStyleElement",
    "DocumentFragment",
    "ShadowRoot",
    "Text",
    "DOMRect",
    "Range",
    "Selection",
    "Image",
    "XMLHttpRequest",
    "FileReader",
    "Worker",
    "EventTarget",
  ];

  for (const domClassName of domClassNames) {
    if (globalThis[domClassName] === undefined) {
      globalThis[domClassName] = class extends FakeDomClass {};
    }
  }
}
