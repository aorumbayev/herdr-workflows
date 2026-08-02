# simplify-module-interfaces

Three layers, nine interfaces: prune ~230 exports to ~19 entry points with behavior intact.

## Final decision

Implemented as designed. A later simplification program then consolidated production into about 14 TypeScript files plus web assets (`update`, `runs-browser`, `inputs`, `exchange` extractions, and a flat layout). That consolidation supersedes the original "no file merges" constraint. See `design.md` Final decision.
