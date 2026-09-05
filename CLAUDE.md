# Theme Mixer — working notes

A VS Code extension that mixes, edits and exports color themes. TypeScript, ESM, bundled with tsdown.

## Verify

```bash
npx tsc --noEmit                               # must pass clean
npx eslint --config ./eslint.config.mjs --fix src webview
node --test src/syntax/token-color-matcher.test.ts src/sync/theme-sync-merge.test.ts src/theme/adjust-colors.test.ts src/theme/theme-palette.test.ts
npm run build
npx vsce package --no-dependencies --allow-missing-repository
```

## How a theme actually gets applied

The extension contributes two **real** themes in `package.json` — `Theme Mixer (Dark)` and
`(Light)` — and rewrites their JSON files on disk. VS Code's watcher notices the write and repaints
with no window reload. Nothing goes through `workbench.colorCustomizations`.

Three facts hold this up:

- The watcher only arms when the contribution carries **`_watch: true`**. That flag is undocumented
  and the VS Code source calls it unsupported. It has survived 1.100 → 1.136. If it ever disappears,
  the fallback is writing every key into `colorCustomizations` — but note the brief's warning that
  `textMateRules` layer on top of the active theme instead of replacing it, so syntax colors leak
  through that route.
- An extension development host watches **every** theme regardless of the flag. F5 therefore proves
  nothing about `_watch`. Only an installed `.vsix` plus a full relaunch does.
- Only `FileChangeType.UPDATED` triggers it. Overwrite in place. Never write-then-rename.

There is no runtime API to register a theme, so N saved themes still share those two slots.

**The extension never changes `workbench.colorTheme` on its own.** Applying only writes the file. If
the window is on some other theme, edits are invisible and the panel shows a warning bar with a
"Show this theme" button — `showEditorTheme` is the one place the setting gets written, and only
because the user pressed that. Switching base follows along only when the window is already on one
of the editor's two themes.

`writeGeneratedTheme` skips a write whose bytes match the file. Without that, the activate-time
restore repainted at every startup and the theme visibly loaded late.

The adjustment sliders live in the document as `colorAdjustments`, keyed by take target id, and the
stored colors stay unadjusted. `composeAdjustedTheme` bakes them in and strips the field wherever a
theme leaves the editor: `writeGeneratedTheme`, `openExportableTheme`, and the panel's `adjustedValue`.
The token inspector stays on the stored theme on purpose. A new rule seeded from a composed color would
carry the adjustment baked in and then be adjusted again.

The palette groups on the **saved** theme's values, never the working copy's. Every replacement is computed
from the saved value of each key against the saved swatch color. That is what keeps a group stable while
dragging and makes dragging back to the original color restore the saved values exactly. Groups only change
on Save, Discard, or a tick in the category list.

## Storage and the working copy

Saved themes are JSON documents under `context.globalStorageUri/themes/`, next to `index.json`, which
carries what the document cannot: a revision vector per theme, `updatedAt`, a tombstone (`deletedAt`)
and where each part was taken from. `theme-storage.ts` is the only file that reads or writes under
`themes/`. `globalState` holds only small things: the active theme per base, the editing base, the
machine id, the sync on/off flag and the gist id.

**Do not put theme bodies in `globalState` with `setKeysForSync`.** It rides the Extensions sync
resource, one shared payload with a server limit around 100KB, and going over it throws the user's
entire Settings Sync run — silently, forever. Sync goes through a gist instead (below).

**One write chain.** Every write under `themes/` runs through `runStorageOperation`, one at a time.
Silent operations (the migration, a sync apply) do not fire `onDidWriteSavedThemes`; everything else
does, and that event is what schedules a sync run. Never call an exported write from inside another
chained operation — it deadlocks. The unchained bodies are the `...FileAndEntry` functions and
`openActiveSavedThemeInChain`.

Edits go to an in-memory working copy (`workingThemeByBase`), which paints immediately but reaches
storage only on Save. Discard re-applies the saved version. Anything that would replace unsaved edits
calls `settleUnsavedChanges` first. Quitting dirty discards, since activate restores from storage.

Files written into the extension's own install directory are wiped by every extension update. That is
what `restoreGeneratedThemeFiles` exists for, and why it runs on `onStartupFinished`. The index
migration runs first inside it, every activate.

## Sync

The facts that hold it up:

- **What syncs:** the saved theme documents and their index entries, through one secret gist named
  `vscode-theme-editor:themes`. Never the working copy, the generated files, the token, the ETag, the
  machine id or the on/off flag.
- **The gist id is the only synced key.** `setKeysForSync(["syncGistId"])` in `startThemeSync`. The
  on/off flag is per machine on purpose. The machine id is per VS Code profile, which is what makes two
  profiles two machines.
- **Vector clocks, not timestamps.** The merge in `theme-sync-merge.ts` compares revision vectors and
  nothing else. `updatedAt` only breaks a conflict tie and paints "2 min ago". `deletedAt` only expires
  tombstones after 30 days. The merge is pure and has the one other test suite.
- **Nothing is dropped without a copy.** A concurrent edit becomes `<name> (conflict)`. An edit
  concurrent with a delete wins. A pull never touches the working copy; it sets
  `hasRemoteChangesUnderneath` and Save asks. A pull that deletes the theme being edited keeps its file
  until Save or Discard settles it; a restart in between is cleaned up by the migration.
- **The merge runs inside the storage chain** so a Save cannot land between the local read and the
  index write and get its entry overwritten. The gist read and the PATCH happen outside it.
- **The PATCH is check-then-write.** A 304 on the re-read means nobody moved the gist; a 200 means
  merge again. A second 200 gives up until the next trigger. Stale writes cost a re-push or a conflict
  copy, never an edit, because rows 6 and 9 of the table above `mergeSavedTheme` handle a rolled-back
  remote.
- **Anything handed to another API is data.** Index entries and documents from the gist are validated
  in `theme-sync.ts` before the merge sees them, and file names must be `<uuid>.json`. The token only
  goes to GitHub hosts.

`scripts/probe-gist-api.mjs` exercises the client against the real API with a personal access token.
Run it after touching `github-gist-client.ts`.

## Layout

| File                                       | What it holds                                                        |
| ------------------------------------------ | -------------------------------------------------------------------- |
| `src/index.ts`                             | Activation and the message switch. Wiring only                       |
| `src/theme/generated-theme-file.ts`        | Reads and writes the two contributed theme files                     |
| `src/theme/apply-theme.ts`                 | The single "make this visible" path, debounced 50ms                  |
| `src/theme/theme-storage.ts`               | Saved themes and `index.json`, the write chain, migration, restore   |
| `src/theme/working-theme.ts`               | The editing base, the unsaved copy, save/discard, last apply failure |
| `src/theme/hex-color.ts`                   | Hex parse and format. Shared with the webview, no vscode import      |
| `src/theme/adjust-colors.ts`               | The slider values and the color math. Pure, tested                   |
| `src/theme/compose-adjusted-theme.ts`      | Bakes the sliders into a theme. The one caller of the math           |
| `src/theme/theme-palette.ts`               | Groups colors by hue, swaps one everywhere. Pure, tested, webview too |
| `src/sync/github-gist-client.ts`           | The gists API over `fetch`. No `vscode` import. Never throws         |
| `src/sync/theme-sync-merge.ts`             | Vector clocks and the merge. Pure, tested                            |
| `src/sync/theme-sync.ts`                   | The sync run, auth, the gist cache, what a pull paints               |
| `src/theme/workbench-color-catalog.ts`     | The 982 color ids, grouped into eleven buckets                       |
| `src/theme/export-theme.ts`                | Writes a standalone theme extension                                  |
| `src/borrow/installed-themes.ts`           | Discovery of installed themes, include chains, JSONC                 |
| `src/borrow/pick-and-take.ts`              | The quick pick that previews live and rolls back on Escape           |
| `src/borrow/take-from-theme.ts`            | Take targets: buckets, syntax, whole theme. Commits a take           |
| `src/syntax/textmate-tokenizer.ts`         | Scope stack at a position, via vscode-textmate                       |
| `src/syntax/token-color-matcher.ts`        | Which `tokenColors` rule wins, per property                          |
| `src/syntax/token-colors.ts`               | Rule edits and the cursor inspector                                  |
| `src/panel/theme-editor-view.ts`           | The webview provider and the page HTML                               |
| `src/panel/webview-protocol.ts`            | The message contract. Both sides import it                           |
| `webview/`                                 | The page itself. Plain DOM, no framework                             |
| `data/workbench-color-ids.json`            | Generated. Do not hand-edit                                          |
| `scripts/generate-workbench-color-ids.mjs` | Regenerates that file from a pinned VS Code tag                      |

## Traps that have already bitten

- **Bundling.** Everything except `vscode` must be inlined, because packaging uses
  `--no-dependencies`. Runtime libraries live in `devDependencies` on purpose. `jsonc-parser` ships a
  UMD build that calls `require()` at runtime, which survives bundling as a broken path — the node
  build sets `resolve.mainFields` to prefer `module` so the ESM build wins.
- **`onig.wasm`** is read at runtime, not imported. tsdown copies it to `lib/`, and tsdown's `copy.to`
  is a directory, not a file path.
- **`.vscodeignore` must exist.** Without it vsce falls back to `.gitignore` and ships a vsix with no
  `lib/`.
- **`vsce package` produces an empty vsix under `/private/tmp` on macOS.** Not a manifest problem.
  Test packaging somewhere else.
- **Syntax highlighting is not a workbench bucket.** The "Editor Decorations" bucket holds brackets,
  symbol icons and links. The colors of the code are `tokenColors` and `semanticTokenColors`, which
  are borrowed through their own take target (`SYNTAX_HIGHLIGHTING_TAKE_TARGET_ID`), never a bucket.
- **State that is not structural does not re-render on its own.** `showCategories` rebuilds only when
  the category structure changes. Per-state values have to be refilled outside that guard.
- Semantic tokens from a language server override TextMate rules. The inspector says so, because
  otherwise editing a rule looks broken.
- The matcher implements VS Code's TextMate algorithm only. The score-based matcher used for semantic
  tokens and tree-sitter is a different algorithm and is not written.

## Decisions already made

Do not reopen these without asking:

- Sync is a secret gist, merged by vector clocks. No `globalState` bodies, no timestamps deciding
  merges, no `colorCustomizations`. Turning sync off is per machine.
- Plist (`.tmTheme`) and legacy `settings`-format themes are filtered out, not parsed.
- The picker offers both bases, same base first. A terminal palette or the code colors can fit
  either way, so the user chooses.
- No `colorCustomizations` fallback until `_watch` actually breaks. Speculative code stays out.
