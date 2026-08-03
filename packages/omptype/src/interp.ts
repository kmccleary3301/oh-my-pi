/**
 * Tree-walking validator used for a schema's first few calls and as the
 * targeted fallback for recursive or predicate-only JIT subtrees.
 *
 * Semantics must stay in lockstep with `compile.ts`:
 * - success returns the output value; the input is returned as-is unless the
 *   schema morphs (defaults, `"+": "delete"`, embedded stepped schemas), in
 *   which case a fresh object/array is produced and the input is untouched
 * - failure returns an `OmpErrors` with a single fast-fail entry
 */
import { MISSING, OmpErrors } from "./errors";
import { expectedOf, hasMorph, type IR } from "./ir";

const own = Object.prototype.hasOwnProperty;

/** Validate `value` against `ir`; returns output value or `OmpErrors`. */
export function walk(ir: IR, value: unknown): unknown {
	const path: PropertyKey[] = [];
	const out = visit(ir, value, path);
	return out;
}

function fail(path: PropertyKey[], expected: string, data: unknown): OmpErrors {
	const storedPath = path.length === 0 ? undefined : path.length === 1 ? path[0] : [...path];
	return new OmpErrors(storedPath, expected, data);
}

/** Pure predicate used for union-member scanning (no morphs, no errors). */
function checks(ir: IR, v: unknown): boolean {
	switch (ir.k) {
		case "unknown":
			return true;
		case "null":
			return v === null;
		case "undefined":
			return v === undefined;
		case "boolean":
			return typeof v === "boolean";
		case "bigint":
			return typeof v === "bigint";
		case "symbol":
			return typeof v === "symbol";
		case "never":
			return false;
		case "anyobject":
			return typeof v === "object" && v !== null;
		case "string":
			return (
				typeof v === "string" &&
				(ir.min === undefined || v.length >= ir.min) &&
				(ir.max === undefined || v.length <= ir.max) &&
				(!ir.url || URL.canParse(v))
			);
		case "number":
			if (typeof v !== "number") return false;
			return (
				(ir.int ? Number.isInteger(v) : Number.isFinite(v)) &&
				(ir.divisor === undefined || v % ir.divisor === 0) &&
				(ir.min === undefined || (ir.xmin ? v > ir.min : v >= ir.min)) &&
				(ir.max === undefined || (ir.xmax ? v < ir.max : v <= ir.max))
			);
		case "lit":
			return ir.v instanceof Date ? v instanceof Date && v.valueOf() === ir.v.valueOf() : v === ir.v;
		case "union":
			return ir.members.some(m => checks(m, v));
		case "intersection":
			return ir.members.every(member => checks(member, v));
		case "array": {
			if (!Array.isArray(v)) return false;
			if (ir.min !== undefined && v.length < ir.min) return false;
			if (ir.max !== undefined && v.length > ir.max) return false;
			for (const el of v) if (!checks(ir.el, el)) return false;
			return true;
		}
		case "tuple": {
			if (!Array.isArray(v)) return false;
			let required = ir.postfix.length;
			for (const item of ir.prefix) if (!item.opt && !item.hasDefault) required++;
			if (v.length < required) return false;
			if (ir.variadic === undefined && v.length > ir.prefix.length + ir.postfix.length) return false;
			const postfixStart = v.length - ir.postfix.length;
			const prefixCount = Math.min(ir.prefix.length, postfixStart);
			for (let index = 0; index < prefixCount; index++) {
				if (!checks(ir.prefix[index].val, v[index])) return false;
			}
			for (let index = prefixCount; index < ir.prefix.length; index++) {
				const item = ir.prefix[index];
				if (!item.opt && !item.hasDefault) return false;
			}
			if (ir.variadic !== undefined) {
				for (let index = prefixCount; index < postfixStart; index++) {
					if (!checks(ir.variadic, v[index])) return false;
				}
			}
			for (let index = 0; index < ir.postfix.length; index++) {
				if (!checks(ir.postfix[index], v[postfixStart + index])) return false;
			}
			return true;
		}
		case "object": {
			if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
			const rec = v as Record<string, unknown>;
			for (const p of ir.props) {
				const present = p.key in rec;
				if (!present) {
					if (!p.opt && !p.hasDefault) return false;
					continue;
				}
				if (!checks(p.val, rec[p.key])) return false;
			}
			if (ir.index) {
				for (const key in rec) {
					if (own.call(rec, key) && !checks(ir.index, rec[key])) return false;
				}
			} else if (ir.extras === "reject") {
				for (const key in rec) {
					if (!own.call(rec, key)) continue;
					let declared = false;
					for (const p of ir.props) {
						if (p.key === key) {
							declared = true;
							break;
						}
					}
					if (!declared) return false;
				}
			}
			return true;
		}
		case "instance":
			return v instanceof ir.ctor;
		case "refine":
			if (!checks(ir.base, v)) return false;
			try {
				return ir.pred(v);
			} catch {
				return false;
			}
		case "alias":
			return checks(ir.resolve(), v);
		case "morph":
			return checks(ir.input, v);
		case "sub":
			return !(ir.schema.run(v) instanceof OmpErrors);
	}
}

function visit(ir: IR, v: unknown, path: PropertyKey[]): unknown {
	switch (ir.k) {
		case "alias":
			return visit(ir.resolve(), v, path);
		case "refine": {
			const base = visit(ir.base, v, path);
			if (base instanceof OmpErrors) return base;
			try {
				return ir.pred(base) ? base : fail(path, ir.expected, base);
			} catch {
				return fail(path, ir.expected, base);
			}
		}
		case "morph": {
			const input = visit(ir.input, v, path);
			if (input instanceof OmpErrors) return input;
			const context = {
				error: (expected: string, data: unknown = input) => fail(path, expected, data),
				reject: (problem: string, data: unknown = input) => fail(path, problem, data),
			};
			const output = ir.fn(input, context);
			if (output instanceof OmpErrors) return output;
			return ir.out === undefined ? output : visit(ir.out, output, path);
		}
		case "intersection": {
			let output = v;
			for (const member of ir.members) {
				output = visit(member, output, path);
				if (output instanceof OmpErrors) return output;
			}
			return output;
		}
		case "sub": {
			const out = ir.schema.run(v);
			if (out instanceof OmpErrors) {
				return path.length === 0 ? out : prefixAll(out, path);
			}
			return out;
		}
		case "union": {
			// fast path: any pure member matching returns the input unchanged
			for (const m of ir.members) {
				if (m.k !== "sub" && checks(m, v)) {
					if (hasMorph(m)) break;
					return v;
				}
			}
			for (const m of ir.members) {
				if (m.k === "sub" || hasMorph(m)) {
					const out = visit(m, v, path);
					if (!(out instanceof OmpErrors)) return out;
				}
			}
			return ir.members.some(canRefineUnionFailure) ? unionFail(ir, v, path) : fail(path, expectedOf(ir), v);
		}
		case "array": {
			if (!Array.isArray(v)) return fail(path, "an array", v);
			if (ir.min !== undefined && v.length < ir.min) return fail(path, `at least length ${ir.min}`, v);
			if (ir.max !== undefined && v.length > ir.max) return fail(path, `at most length ${ir.max}`, v);
			if (!hasMorph(ir.el)) {
				for (let i = 0; i < v.length; i++) {
					if (!checks(ir.el, v[i])) {
						path.push(i);
						const err = visit(ir.el, v[i], path);
						path.pop();
						return err instanceof OmpErrors ? err : fail([...path, i], expectedOf(ir.el), v[i]);
					}
				}
				return v;
			}
			const out = new Array<unknown>(v.length);
			for (let i = 0; i < v.length; i++) {
				path.push(i);
				const el = visit(ir.el, v[i], path);
				path.pop();
				if (el instanceof OmpErrors) return el;
				out[i] = el;
			}
			return out;
		}
		case "tuple": {
			if (!Array.isArray(v)) return fail(path, "an array", v);
			let required = ir.postfix.length;
			for (const item of ir.prefix) if (!item.opt && !item.hasDefault) required++;
			if (v.length < required) return fail(path, `an array of at least length ${required}`, v);
			const maximum = ir.prefix.length + ir.postfix.length;
			if (ir.variadic === undefined && v.length > maximum) {
				return fail(path, `an array of at most length ${maximum}`, v);
			}
			const postfixStart = v.length - ir.postfix.length;
			const prefixCount = Math.min(ir.prefix.length, postfixStart);
			const morph = hasMorph(ir);
			const output = morph ? [...v] : v;
			for (let index = 0; index < prefixCount; index++) {
				path.push(index);
				const item = visit(ir.prefix[index].val, v[index], path);
				path.pop();
				if (item instanceof OmpErrors) return item;
				if (morph) output[index] = item;
			}
			for (let index = prefixCount; index < ir.prefix.length; index++) {
				const item = ir.prefix[index];
				if (item.hasDefault && morph) {
					const payload = item.def;
					output[index] = item.defFactory && typeof payload === "function" ? payload() : payload;
				} else if (!item.opt) {
					path.push(index);
					const error = fail(path, expectedOf(item.val), MISSING);
					path.pop();
					return error;
				}
			}
			if (ir.variadic !== undefined) {
				for (let index = prefixCount; index < postfixStart; index++) {
					path.push(index);
					const item = visit(ir.variadic, v[index], path);
					path.pop();
					if (item instanceof OmpErrors) return item;
					if (morph) output[index] = item;
				}
			}
			for (let index = 0; index < ir.postfix.length; index++) {
				const inputIndex = postfixStart + index;
				path.push(inputIndex);
				const item = visit(ir.postfix[index], v[inputIndex], path);
				path.pop();
				if (item instanceof OmpErrors) return item;
				if (morph) output[inputIndex] = item;
			}
			return output;
		}
		case "object": {
			if (typeof v !== "object" || v === null || Array.isArray(v)) return fail(path, "an object", v);
			const rec = v as Record<string, unknown>;
			const morph = hasMorph(ir);
			let out: Record<string, unknown> | undefined;
			if (morph) {
				if (ir.extras === "delete" && !ir.index) {
					out = {};
				} else {
					out = { ...rec };
				}
			}
			for (const p of ir.props) {
				if (!(p.key in rec)) {
					if (p.hasDefault && out) {
						// defFactory guarantees a callable default payload
						const payload = p.def;
						out[p.key] = p.defFactory && typeof payload === "function" ? payload() : payload;
						continue;
					}
					if (p.opt || p.hasDefault) continue;
					path.push(p.key);
					const err = fail(path, expectedOf(p.val), MISSING);
					path.pop();
					return err;
				}
				path.push(p.key);
				const res = visit(p.val, rec[p.key], path);
				path.pop();
				if (res instanceof OmpErrors) return res;
				if (out) out[p.key] = res;
			}
			if (ir.index) {
				for (const key in rec) {
					if (!own.call(rec, key)) continue;
					path.push(key);
					const res = visit(ir.index, rec[key], path);
					path.pop();
					if (res instanceof OmpErrors) return res;
					if (out) out[key] = res;
				}
			} else if (ir.extras === "reject") {
				for (const key in rec) {
					if (!own.call(rec, key)) continue;
					let declared = false;
					for (const p of ir.props) {
						if (p.key === key) {
							declared = true;
							break;
						}
					}
					if (!declared) {
						path.push(key);
						const err = fail(path, "removed (undeclared key)", rec[key]);
						path.pop();
						return err;
					}
				}
			}
			return out ?? v;
		}
		default:
			return checks(ir, v) ? v : fail(path, expectedOf(ir), v);
	}
}

function prefixAll(errs: OmpErrors, path: PropertyKey[]): OmpErrors {
	for (let i = path.length - 1; i >= 0; i--) errs.prefix(path[i]);
	return errs;
}

/** True when a union failure can be replaced with a more specific nested error. */
export function canRefineUnionFailure(member: IR): boolean {
	const base = member.k === "sub" ? member.schema.ir : member;
	if (member.k === "sub") {
		return (
			base.k === "array" ||
			base.k === "object" ||
			base.k === "anyobject" ||
			base.k === "string" ||
			base.k === "number"
		);
	}
	if (base.k === "array" || base.k === "object") return true;
	if (base.k === "string") return base.min !== undefined || base.max !== undefined || base.url === true;
	return base.k === "number" && (base.int === true || base.min !== undefined || base.max !== undefined);
}

/**
 * Detailed failure for a union: descend into the member the value was clearly
 * aimed at — unique runtime-kind match, else an object member whose literal
 * discriminant property (e.g. `type: "'computer_call'"`) equals the value's —
 * for a precise nested error (paths, narrow messages) instead of the coarse
 * "A or B" expectation.
 */
export function unionFail(ir: IR & { k: "union" }, v: unknown, path: PropertyKey[], expected?: string): OmpErrors {
	let best: IR | undefined;
	for (const m of ir.members) {
		const base = m.k === "sub" ? m.schema.ir : m;
		if (!kindMatches(base, v)) continue;
		if (best !== undefined) {
			best = undefined;
			break;
		}
		best = m;
	}
	if (best === undefined) best = discriminate(ir.members, v);
	if (best) {
		const out = visit(best, v, path);
		if (out instanceof OmpErrors) return out;
	}
	return fail(path, expected ?? expectedOf(ir), v);
}

/** Pick the sole object member whose literal-typed property matches the value's. */
function discriminate(members: IR[], v: unknown): IR | undefined {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
	const rec = v as Record<string, unknown>;
	let match: IR | undefined;
	for (const m of members) {
		const base = m.k === "sub" ? m.schema.ir : m;
		if (base.k !== "object") continue;
		for (const p of base.props) {
			if (p.val.k !== "lit" || rec[p.key] !== p.val.v) continue;
			if (match !== undefined) return undefined; // ambiguous
			match = m;
			break;
		}
	}
	return match;
}

/** True when a value's runtime shape could only be aimed at this member. */
function kindMatches(base: IR, v: unknown): boolean {
	switch (base.k) {
		case "array":
			return Array.isArray(v);
		case "object":
		case "anyobject":
			return typeof v === "object" && v !== null && !Array.isArray(v);
		case "string":
			return typeof v === "string";
		case "number":
			return typeof v === "number";
		default:
			return false;
	}
}
