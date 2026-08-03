# Changelog

## [Unreleased]

### Added

- Initial release: ArkType-compatible schema validation with a lazy JIT runtime. Schemas interpret their first two calls and compile a specialized validator via `new Function` on the third, making `type()` construction ~100x cheaper than arktype while beating its hot-path validation speed. Supports the string definition DSL (primitives, literals, unions, arrays, bounds, `number.integer`, `string.url`, inline defaults, value-suffix `?` optionals), object definitions (`"+": "reject"/"delete"`, `"[string]"` index signatures), `type.errors`/`OmpErrors` with per-entry `path`/`problem`, `type.enumerated`, `type.raw`, keyword statics, composition methods (`.or/.and/.array/.pipe/.narrow/.describe/.default/.allows/.assert`), static inference via `typeof schema.infer`, and draft-2020-12 `toJsonSchema()` emission.
- TypeBox-style (`@oh-my-pi/omptype/typebox`) and Zod-style (`@oh-my-pi/omptype/zod`) authoring adapters producing native omptype schemas.
- Added recursive named scopes, modules and runtime generics; fixed/optional/variadic tuples; Date literals and bounds; nested string and parse keyword modules; disjointness-aware intersections; structural mapping, selection, distribution and semantic comparison; separate input/output inference; configurable error codes and `byPath`; and JSON Schema target, dialect and fallback handling.
- npm package now ships transpiled ESM in `dist/js` and declarations in `dist/types`, so it runs on plain Node without Bun or a TS loader; Bun consumers keep resolving TS source via the `bun` export condition.

### Changed

- Expanded the lazy JIT across tuples, refinements, morphs, intersections, instances, and recursive aliases; reused compiled validators for shared IR and tightened number and literal-union code generation.
