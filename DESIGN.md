# Workbench design

The page is an Operate surface: a light instrument panel for moving between source, relationships, and diagnostics. Users work with dense data in ordinary ambient light; white panels and a pale blue-gray canvas preserve code and graph legibility.

Keep styling simple and native: `system-ui` for all text, system monospace only for JSON and code, unstyled native controls, and a small set of `light-dark()` colour variables so the page follows the system light or dark theme. Errors are red, warnings ochre, and successful validation green. Graphviz labels use Helvetica, one of the fonts Graphviz has metrics for.

Desktop maintains source, preview, and inspector columns with persistent toolbars. At intermediate widths, the inspector moves below the editing panes; mobile stacks all three in task order. Avoid decorative cards: thin rules separate functional regions. Small rounded corners belong to controls and the outer workspace.

Selection is shared between graph elements and inspector. Diagnostics select source ranges. The preview clears immediately on edits and errors; layout activity, limits, and failures have explicit messages. Controls support visible keyboard focus, graph items support Enter/Space, and native Tab navigation remains intact. Graph reveal motion is brief and disabled for reduced-motion preferences.
