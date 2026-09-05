# Changelog

## 0.3.0

- Renamed to Theme Color Mixer. The two contributed themes are now "Theme Color Mixer (Dark)" and
  "(Light)", so a window on the old name has to pick the theme again.
- The adjustment sliders work on ticked parts, the same way as the palette. Tick one part to tune it
  alone or every part to adjust the whole theme. A slider says "mixed" while the ticked parts differ,
  and a dot marks each part that is off center.
- The token inspector is its own section above Colors and shows only the rule that paints the token
  under the cursor, editable in place. The rule list is a plain category under Colors, filtered by the
  Colors search instead of a filter of its own.
- Following the cursor turns itself off when the panel is closed.
- A Compare button in the unsaved bar. Hold it to see the saved version, let go to get the edits back.

## 0.2.0

- A palette section. The theme's colors are grouped by hue into swatches, and picking a new color
  for a swatch changes every key that uses that hue. Tick which parts of the window take part.
- Each swatch has a revert button that puts the saved colors back for that group only.

## 0.1.0

First release.

- Mix parts of installed themes, with a live preview while you pick.
- Edit every workbench color, with search and a flash button that shows what a color paints.
- Brightness, contrast and saturation sliders for the whole theme or one part of it.
- A syntax panel that names token rules in plain English and shows which rule colors the token under
  the cursor.
- Export as a theme extension folder, a `.vsix`, or a plain JSON file, or install straight into VS Code.
- Optional sync of saved themes through a secret gist.
