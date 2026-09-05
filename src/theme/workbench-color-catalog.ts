import * as vscode from "vscode";

import type { ColorThemeDocument, ThemeBaseKind } from "./generated-theme-file.ts";
import type { ColorCategoryView, ColorKeyView } from "../panel/webview-protocol.ts";

// A raw category is the text before the first dot of a color id. VS Code 1.136.1 has 218 of them, far too many
// to browse. One not listed here lands in "Other". Nothing is dropped.
const COLOR_BUCKETS: ColorBucketDefinition[] = [
  {
    id: "editor",
    label: "Editor",
    rawCategories: [
      "editor",
      "editorActiveLineNumber",
      "editorCursor",
      "editorError",
      "editorGroup",
      "editorGutter",
      "editorHint",
      "editorIndentGuide",
      "editorInfo",
      "editorLightBulb",
      "editorLightBulbAi",
      "editorLightBulbAutoFix",
      "editorLineNumber",
      "editorMinimap",
      "editorMultiCursor",
      "editorOverviewRuler",
      "editorPane",
      "editorRuler",
      "editorStickyScroll",
      "editorStickyScrollGutter",
      "editorStickyScrollHover",
      "editorWarning",
      "editorWhitespace",
      "interactive",
      "minimap",
      "minimapGutter",
      "minimapSlider",
      "notebook",
      "notebookEditorOverviewRuler",
      "notebookScrollbarSlider",
      "notebookStatusErrorIcon",
      "notebookStatusRunningIcon",
      "notebookStatusSuccessIcon",
      "searchEditor",
      "sideBySideEditor",
    ],
  },
  {
    id: "syntax",
    label: "Editor Decorations",
    rawCategories: [
      "editorBracketHighlight",
      "editorBracketMatch",
      "editorBracketPairGuide",
      "editorCodeLens",
      "editorGhostText",
      "editorInlayHint",
      "editorLink",
      "editorUnicodeHighlight",
      "editorUnnecessaryCode",
      "markdownAlert",
      "symbolIcon",
      "textBlockQuote",
      "textCodeBlock",
      "textLink",
      "textPreformat",
      "textSeparator",
    ],
  },
  {
    id: "terminal",
    label: "Terminal",
    rawCategories: [
      "terminal",
      "terminalCommandDecoration",
      "terminalCommandGuide",
      "terminalCursor",
      "terminalOverviewRuler",
      "terminalStickyScroll",
      "terminalStickyScrollHover",
      "terminalSymbolIcon",
    ],
  },
  {
    id: "sidebar",
    label: "Sidebar & Panels",
    rawCategories: [
      "activityBar",
      "activityBarBadge",
      "activityBarTop",
      "activityErrorBadge",
      "activityWarningBadge",
      "commentsView",
      "extensionBadge",
      "extensionButton",
      "extensionIcon",
      "list",
      "listFilterWidget",
      "modernActivityBar",
      "modernActivityBarItem",
      "outputView",
      "outputViewStickyScroll",
      "panel",
      "panelInput",
      "panelSection",
      "panelSectionHeader",
      "panelStickyScroll",
      "panelTitle",
      "panelTitleBadge",
      "ports",
      "profileBadge",
      "profiles",
      "search",
      "sideBar",
      "sideBarActivityBarTop",
      "sideBarSectionHeader",
      "sideBarStickyScroll",
      "sideBarTitle",
      "tree",
    ],
  },
  {
    id: "tabs",
    label: "Tabs & Breadcrumbs",
    rawCategories: ["breadcrumb", "breadcrumbPicker", "editorGroupHeader", "modernEditorTab", "modernTab", "tab"],
  },
  {
    id: "status",
    label: "Status Bar & Title Bar",
    rawCategories: ["banner", "commandCenter", "menu", "menubar", "statusBar", "statusBarItem", "titleBar", "toolbar"],
  },
  {
    id: "widgets",
    label: "Popups & Controls",
    rawCategories: [
      "actionBar",
      "browser",
      "button",
      "checkbox",
      "dropdown",
      "editorActionList",
      "editorCommentsWidget",
      "editorHoverWidget",
      "editorMarkerNavigation",
      "editorMarkerNavigationError",
      "editorMarkerNavigationInfo",
      "editorMarkerNavigationWarning",
      "editorSuggestWidget",
      "editorSuggestWidgetStatus",
      "editorWidget",
      "input",
      "inputOption",
      "inputValidation",
      "keybindingLabel",
      "keybindingTable",
      "notificationCenter",
      "notificationCenterHeader",
      "notificationLink",
      "notificationToast",
      "notifications",
      "notificationsErrorIcon",
      "notificationsInfoIcon",
      "notificationsWarningIcon",
      "peekView",
      "peekViewEditor",
      "peekViewEditorGutter",
      "peekViewEditorStickyScroll",
      "peekViewEditorStickyScrollGutter",
      "peekViewResult",
      "peekViewTitle",
      "peekViewTitleDescription",
      "peekViewTitleLabel",
      "pickerGroup",
      "quickInput",
      "quickInputList",
      "quickInputTitle",
      "radio",
      "settings",
      "simpleFindWidget",
      "walkThrough",
      "walkthrough",
      "welcomePage",
    ],
  },
  {
    id: "git",
    label: "Git & Diff",
    rawCategories: [
      "diffEditor",
      "diffEditorGutter",
      "diffEditorOverview",
      "git",
      "gitDecoration",
      "merge",
      "mergeEditor",
      "multiDiffEditor",
      "scmGraph",
    ],
  },
  {
    id: "debug",
    label: "Debug & Testing",
    rawCategories: [
      "debugConsole",
      "debugConsoleInputIcon",
      "debugExceptionWidget",
      "debugIcon",
      "debugToolBar",
      "debugTokenExpression",
      "debugView",
      "problemsErrorIcon",
      "problemsInfoIcon",
      "problemsWarningIcon",
      "testing",
    ],
  },
  {
    id: "chat",
    label: "Chat & AI",
    rawCategories: [
      "activeSessionView",
      "agentFeedbackEditorWidget",
      "agentFeedbackInputWidget",
      "agentSessionReadIndicator",
      "agentSessionSelectedBadge",
      "agentSessionSelectedUnfocusedBadge",
      "agentStatusIndicator",
      "agents",
      "agentsBadge",
      "agentsBottomPanel",
      "agentsCard",
      "agentsChatInput",
      "agentsGradient",
      "agentsMobileDiff",
      "agentsNewSessionButton",
      "agentsPanel",
      "agentsUnreadBadge",
      "agentsUpdateButton",
      "agentsVoice",
      "chat",
      "inactiveSessionView",
      "inlineChat",
      "inlineChatDiff",
      "inlineChatInput",
      "inlineEdit",
      "mcpIcon",
    ],
  },
  {
    id: "base",
    label: "General",
    rawCategories: [
      "badge",
      "chart",
      "charts",
      "contrastActiveBorder",
      "contrastBorder",
      "descriptionForeground",
      "disabledForeground",
      "errorForeground",
      "focusBorder",
      "foreground",
      "icon",
      "progressBar",
      "sash",
      "scrollbar",
      "scrollbarSlider",
      "selection",
      "strongForeground",
      "surface",
      "widget",
      "window",
    ],
  },
];

const OTHER_BUCKET: ColorBucket = { id: "other", label: "Other" };

// Still registered, no longer used. An imported theme can still carry values for them.
const DEPRECATED_BUCKET: ColorBucket = { id: "deprecated", label: "Deprecated" };

// Ids a theme sets that this catalog does not know. Extensions register their own, and newer VS Code adds more.
const UNKNOWN_BUCKET: ColorBucket = { id: "unknown", label: "Not in this VS Code" };

const WORKBENCH_COLOR_IDS_FILE_PATH = "data/workbench-color-ids.json";

export interface ColorBucket {
  id: string;
  label: string;
}

interface ColorBucketDefinition extends ColorBucket {
  rawCategories: string[];
}

export interface WorkbenchColorMetadata {
  id: string;
  category: string;
  description: string;
  defaults: Record<ThemeBaseKind | "hcDark" | "hcLight", string | null>;
  /** True when the id only makes sense with an alpha channel, such as a selection highlight. */
  needsTransparency: boolean;
  deprecationMessage: string | null;
}

export interface WorkbenchColorCatalog {
  vscodeSourceTag: string;
  metadataByColorId: Map<string, WorkbenchColorMetadata>;
  bucketsInDisplayOrder: ColorBucket[];
  colorIdsByBucketId: Map<string, string[]>;
}

/** Read once per extension host. The file is 400 KB. */
export function loadWorkbenchColorCatalog(context: vscode.ExtensionContext): Promise<WorkbenchColorCatalog> {
  if (!workbenchColorCatalogPromise) {
    // A failed read must not be kept for the rest of the session.
    workbenchColorCatalogPromise = readWorkbenchColorCatalog(context).catch((error: unknown) => {
      workbenchColorCatalogPromise = undefined;
      throw error;
    });
  }

  return workbenchColorCatalogPromise;
}

export async function getColorIdsInBucket(context: vscode.ExtensionContext, bucketId: string): Promise<string[]> {
  const catalog = await loadWorkbenchColorCatalog(context);
  return catalog.colorIdsByBucketId.get(bucketId) ?? [];
}

/** `adjustedTheme` is the same theme with the adjustment sliders baked in. It only feeds `adjustedValue`. */
export async function createColorCategoryViews(
  context: vscode.ExtensionContext,
  theme: ColorThemeDocument,
  base: ThemeBaseKind,
  adjustedTheme: ColorThemeDocument,
  savedTheme: ColorThemeDocument
): Promise<ColorCategoryView[]> {
  const catalog = await loadWorkbenchColorCatalog(context);

  const categoryViews = catalog.bucketsInDisplayOrder.map((bucket): ColorCategoryView => {
    const colorIds = catalog.colorIdsByBucketId.get(bucket.id) ?? [];

    const colorKeyViews = colorIds.map((colorId): ColorKeyView => {
      const metadata = catalog.metadataByColorId.get(colorId);

      return {
        id: colorId,
        description: metadata?.description ?? "",
        value: theme.colors[colorId] ?? null,
        savedValue: savedTheme.colors[colorId] ?? null,
        defaultValue: metadata?.defaults[base] ?? null,
        adjustedValue: adjustedTheme.colors[colorId] ?? null,
      };
    });

    return {
      id: bucket.id,
      label: bucket.label,
      keys: colorKeyViews,
      canImportFromTheme: isImportableBucket(bucket.id),
      takenFromThemeLabel: null,
    };
  });

  const unknownColorKeyViews = createUnknownColorKeyViews(catalog, theme, adjustedTheme, savedTheme);
  if (unknownColorKeyViews.length > 0) {
    categoryViews.push({
      id: UNKNOWN_BUCKET.id,
      label: UNKNOWN_BUCKET.label,
      keys: unknownColorKeyViews,
      canImportFromTheme: false,
      takenFromThemeLabel: null,
    });
  }

  return categoryViews;
}

// The catch-all buckets hold leftovers, not a fixed set of ids. Nothing to copy from another theme.
function isImportableBucket(bucketId: string): boolean {
  return bucketId !== OTHER_BUCKET.id && bucketId !== DEPRECATED_BUCKET.id && bucketId !== UNKNOWN_BUCKET.id;
}

function createUnknownColorKeyViews(
  catalog: WorkbenchColorCatalog,
  theme: ColorThemeDocument,
  adjustedTheme: ColorThemeDocument,
  savedTheme: ColorThemeDocument
): ColorKeyView[] {
  const unknownColorIds = [...new Set([...Object.keys(theme.colors), ...Object.keys(savedTheme.colors)])].filter(
    colorId => !catalog.metadataByColorId.has(colorId)
  );
  unknownColorIds.sort((left, right) => left.localeCompare(right));

  return unknownColorIds.map((colorId): ColorKeyView => {
    return {
      id: colorId,
      description: "",
      value: theme.colors[colorId] ?? null,
      savedValue: savedTheme.colors[colorId] ?? null,
      defaultValue: null,
      adjustedValue: adjustedTheme.colors[colorId] ?? null,
    };
  });
}

interface WorkbenchColorIdsFile {
  vscodeSourceTag: string;
  colors: WorkbenchColorMetadata[];
}

let workbenchColorCatalogPromise: Promise<WorkbenchColorCatalog> | undefined;

async function readWorkbenchColorCatalog(context: vscode.ExtensionContext): Promise<WorkbenchColorCatalog> {
  const fileUri = vscode.Uri.joinPath(context.extensionUri, WORKBENCH_COLOR_IDS_FILE_PATH);
  const fileContents = await vscode.workspace.fs.readFile(fileUri);
  const colorIdsFile = JSON.parse(new TextDecoder().decode(fileContents)) as WorkbenchColorIdsFile;

  return createWorkbenchColorCatalog(colorIdsFile);
}

function createWorkbenchColorCatalog(colorIdsFile: WorkbenchColorIdsFile): WorkbenchColorCatalog {
  const bucketIdByRawCategory = createBucketIdByRawCategory();

  const metadataByColorId = new Map<string, WorkbenchColorMetadata>();
  const colorIdsByBucketId = new Map<string, string[]>();

  for (const metadata of colorIdsFile.colors) {
    metadataByColorId.set(metadata.id, metadata);

    const bucketId = metadata.deprecationMessage
      ? DEPRECATED_BUCKET.id
      : (bucketIdByRawCategory.get(metadata.category) ?? OTHER_BUCKET.id);

    const colorIdsInBucket = colorIdsByBucketId.get(bucketId);
    if (colorIdsInBucket) {
      colorIdsInBucket.push(metadata.id);
      continue;
    }

    colorIdsByBucketId.set(bucketId, [metadata.id]);
  }

  for (const colorIdsInBucket of colorIdsByBucketId.values()) {
    colorIdsInBucket.sort((left, right) => left.localeCompare(right));
  }

  const allBucketsInDisplayOrder = [...COLOR_BUCKETS, OTHER_BUCKET, DEPRECATED_BUCKET];
  const bucketsInDisplayOrder = allBucketsInDisplayOrder
    .filter(bucket => colorIdsByBucketId.has(bucket.id))
    .map(bucket => ({ id: bucket.id, label: bucket.label }));

  return {
    vscodeSourceTag: colorIdsFile.vscodeSourceTag,
    metadataByColorId,
    bucketsInDisplayOrder,
    colorIdsByBucketId,
  };
}

function createBucketIdByRawCategory(): Map<string, string> {
  const bucketIdByRawCategory = new Map<string, string>();

  for (const bucket of COLOR_BUCKETS) {
    for (const rawCategory of bucket.rawCategories) {
      bucketIdByRawCategory.set(rawCategory, bucket.id);
    }
  }

  return bucketIdByRawCategory;
}
