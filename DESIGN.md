# Workbench design

The page is an Operate surface: a light instrument panel for moving between source, relationships, and diagnostics. Users work with dense data in ordinary ambient light; white panels and a pale blue-gray canvas preserve code and graph legibility.

Use the system UI font for controls, headings, and explanations; use system monospace only for JSON, IDs, paths, and measurements. Primary text is slate `#233346`, secondary text `#59697a`, rules `#d6dee7`, and actions/selection cobalt `#2058b8`. Errors are dark red, warnings dark ochre, successful validation dark green. Graphviz labels use Arial to keep generated SVG portable.

Desktop maintains source, preview, and inspector columns with persistent toolbars. At intermediate widths, the inspector moves below the editing panes; mobile stacks all three in task order. Avoid decorative cards: thin rules separate functional regions. Small rounded corners belong to controls and the outer workspace.

Selection is shared between graph elements and inspector. Diagnostics select source ranges. The preview clears immediately on edits and errors; layout activity, limits, and failures have explicit messages. Controls support visible keyboard focus, graph items support Enter/Space, and native Tab navigation remains intact. Graph reveal motion is brief and disabled for reduced-motion preferences.
