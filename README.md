# Theme Editor

Mix, tweak and live-preview VS Code color themes from the sidebar.

You like one theme's syntax colors and another one's editor chrome. This lets you take each part from
wherever you want, tweak whatever still bothers you, and export the result as a real theme.

## Mix from installed themes

Take a whole theme as a starting point, then take individual parts from other themes: the terminal,
the tabs, the git colors, the code colors. Each picker previews live as you move through the list, so
you see the result before committing. Enter keeps it, Escape puts it back.

Taking a part from another theme pins it. Taking a new whole theme leaves it alone, and the × next to
it puts it back whenever you want.

## Edit any color

All 982 workbench color ids, grouped into eleven browsable sections with search. Every row has a
color picker, a hex field, and a flash button that blinks the color so you can find what it actually
paints.

## Adjust colors

Brightness, contrast and saturation sliders for the whole theme or for one part of it, such as the
terminal, the tabs or the code colors. They sit on top of whatever the colors are, borrowed or hand
picked, and are saved with the theme. Dragging a slider back to the middle undoes it.

## Edit the code colors

The syntax panel lists the theme's token rules in plain English (function name, string, comment)
rather than raw TextMate scopes. Turn on _Follow my cursor_, put the caret on a token, and it tells
you which rule colors it and offers to give that token a rule of its own. It also warns you when a
language server is painting the token instead, which is the case where editing a rule looks broken
but isn't.

## Save and discard

Edits paint immediately but are not permanent. Save keeps them, Discard puts the last saved version
back.

## Export and install

Your theme leaves the editor as a real theme that does not need this extension:

- **Install into VS Code** packages it and installs it as an extension of its own, ready to pick from
  the theme list.
- **As extension** writes a folder with its own `package.json` and theme file, ready to publish.
- **As .vsix** builds the installable package, the same thing `vsce package` makes.
- **As JSON file** saves one plain theme file, the format every VS Code theme uses.

## Sync

Off by default. Turn it on and your saved themes live in one secret gist on the GitHub account VS Code
already knows, and every machine with sync on keeps the same set.

The Sync section of the panel creates a secret gist named `vscode-theme-editor:themes` and keeps your
saved themes in it as JSON files. Nothing else on your account is read or changed, and no network
request happens until you press the button.

A secret gist is not private. It does not show on your profile, but anyone who has its link can read
it. Do not put a theme you would not share into a synced editor.

Stopping sync on one machine leaves the gist and every other machine alone. "Stop and delete the
gist" removes it, and other machines then start a fresh gist from their own copies.

Two machines editing the same theme keep both versions. The later edit keeps the name, the other
comes back as `<name> (conflict)`. An edit made while another machine deleted the theme keeps the
edit. Nothing goes away without a copy.

A theme changed or deleted on another machine while you are editing it stays on screen. Save asks
whether to keep yours, theirs, or both.

Deleted themes are remembered for 30 days, which is how a delete reaches a machine that was off. The
30 days count from the deleting machine's clock. A clock far behind lets an offline machine bring the
theme back, and a clock far ahead keeps the note around a little longer. Neither loses data.

A gist holds up to 290 themes. Signed out, rate limited, or offline, sync pauses and editing carries
on. It resumes on the next save or sign-in.

## Using it

Open the Theme Editor icon in the activity bar. Pick Dark or Light, take a whole theme to start from,
then take the parts you want from elsewhere and tweak.

Nothing switches your theme for you. While your window is on some other theme, the panel shows a bar
with a "Show this theme" button, and that button is the only thing that changes it.

Dark and light are separate slots, and switching base switches which of your saved themes is active.
The picker offers themes of both bases, same base first, since a terminal palette or the code colors
can work either way.

## Limits

- Sync needs a GitHub account. GitHub Enterprise is not supported.
- Themes written in the old TextMate plist format, and in VS Code's pre-2017 `settings` format, are
  left out of the mixing list. They cannot be read as JSON.
- Desktop VS Code only, 1.100 or newer. The web version cannot write theme files.

## Building it

```bash
npm install
npm run build          # bundles the extension and the webview
npm run package        # builds a .vsix
```

Press F5 to run it in an extension development host.
