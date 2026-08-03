/** Pipeline: `type(def)` compiles; each call returns data or ArkErrors directly. */
import { type } from "arktype";
import type { Candidate } from "../candidate";
import type { Def } from "../ir";

export const arktypeCandidate: Candidate = {
	name: "arktype",
	type(def: Def) {
		// Runtime-generated benchmark definitions cannot preserve arktype's const generic.
		return type(def as never);
	},
	isErrors: result => result instanceof type.errors,
	summary: result => (result instanceof type.errors ? result.summary : ""),
};
