# Editing generated maps

Atlas keeps user changes in a small, plain-data edit layer rather than changing generation. Name
overrides use stable entity IDs (`nation:2`, `river:5`); province and cell ownership overrides use
decimal indices. Applying political edits always derives cells from edited provinces first, then
lays cell edits on top, so the fine brush wins.

The browser editor is created entirely by `initEditor`. It saves edits in local storage under
`atlas/edits/v<version>/<seed>/<formation-step>`. Storage failures are non-fatal. Selecting a nation
and dragging paints provinces by default; **Fine brush** paints cells, and holding **Alt** paints
unclaimed territory. Clearing a name field restores the generated name.

The host owns the `Edits` object. After a change it restores generated names, applies the edit
layer, rebuilds `PoliticalView`, and renders; rendering therefore continues to consume ownership
only through `PoliticalView`.
