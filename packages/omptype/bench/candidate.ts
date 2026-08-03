/**
 * Contract every benchmark candidate implements.
 *
 * `type(def)` mirrors arktype: returns a callable schema. Calling it with a
 * value returns the (possibly morphed: defaults applied, extras deleted) value
 * on success, or an error object recognized by `isErrors` on failure.
 */
import type { Def } from "./ir";

export type SchemaFn = (value: unknown) => unknown;

export interface Candidate {
	name: string;
	type(def: Def): SchemaFn;
	isErrors(result: unknown): boolean;
	/** Optional error summary string for correctness diagnostics. */
	summary?(result: unknown): string;
}
