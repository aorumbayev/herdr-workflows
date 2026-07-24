//! Workflow load pipeline. Port of `src/workflows/` (tasks 1.4-1.6).
//!
//! Landed (1.4): `parse` (Zod-equivalent schema validation), `refine`
//! (cross-field step rules), `steps` (`rawToFlat`/`checkAgents`/`flatNeeds*`),
//! `placeholder` (pure scanning helpers from `substitute.ts`), `entry`
//! (run-free buffer loader used by the parse-level tests).
//! Landed (1.5): `discover` (repo/global resolution + listing),
//! `flatten` (`run:` splicing), `inputs` (input resolution + `checkInputRefs`),
//! `recovery` (`on_fail` rules), `load` (the full composition the
//! runner/picker/web consume).
//! Landed (1.6): `substitute` (runtime `{placeholder}`/`{input.*}`
//! substitution pass + `PlaceholderValues`).

pub mod discover;
pub mod entry;
pub mod errors;
pub mod flatten;
pub mod inputs;
pub mod load;
pub mod parse;
pub mod placeholder;
pub mod recovery;
pub mod refine;
pub mod steps;
pub mod substitute;
pub mod types;
