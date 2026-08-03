/**
 * Schema IR and the ArkType-compatible definition parser.
 *
 * `parseDef` turns the definition subset this repo uses — string DSL
 * (primitives, literals, unions, arrays, bounds, `number.integer`,
 * `string.url`, inline `= literal` defaults), object literals (optional `?`
 * keys, `"+"` undeclared-key policy, `"[string]"` index signatures), tuple
 * `[def, "[]"]` arrays, and embedded `Type` instances — into a small IR tree
 * consumed by the interpreter (`interp.ts`), the JIT compiler (`compile.ts`),
 * and the JSON Schema emitter (`json-schema.ts`).
 */

import { OmpErrors, OmpTypeError } from "./errors";
import { keywordIR, patternIR, templateIR } from "./keywords";

/** Brand carried by `Type` instances so the parser can embed them in defs. */
export const IR_BRAND: unique symbol = Symbol("omptype.schema");

const kMorph: unique symbol = Symbol("omptype.hasMorph");

interface IRAnalysis {
	[kMorph]?: boolean;
}

/**
 * The parser-facing surface of an embedded `Type` instance.
 * `type.ts` implements this on every schema it creates.
 */
export interface EmbeddableSchema {
	[IR_BRAND]: true;
	/** Structural IR of the schema (base type when runtime steps exist). */
	ir: IR;
	/** True when the schema carries `.pipe()`/`.narrow()` steps. */
	hasSteps: boolean;
	/** `.default()` payload; a function is a factory invoked per fill. */
	defaultValue?: unknown;
	hasDefault: boolean;
	/** `.describe()` annotation, emitted into JSON Schema. */
	description?: string;
	/** Full validate+morph pipeline (identical to calling the schema). */
	run(value: unknown): unknown;
}

/** Policy for undeclared object keys. */
export type Extras = "keep" | "reject" | "delete";

/** Constructor accepted by `type.instanceOf` and tuple `instanceof` expressions. */
export type Constructor = abstract new (...args: never[]) => object;

/** Context available to in-definition morph callbacks. */
export interface MorphContext {
	/** Return a validation error at the current path. */
	error(expectation: string): OmpErrors;
	/** Alias of `error` matching ArkType's rejection vocabulary. */
	reject(expectation: string): OmpErrors;
}

/** One fixed tuple position, optionally absent or defaulted. */
export interface TupleItemIR {
	val: IR;
	opt: boolean;
	def?: unknown;
	defFactory?: boolean;
	hasDefault?: boolean;
}

/** Fixed, optional, variadic, and postfix tuple sequence. */
export interface TupleIR {
	k: "tuple";
	prefix: TupleItemIR[];
	variadic?: IR;
	postfix: IR[];
	desc?: string;
}

export type IR = IRAnalysis &
	(
		| { k: "unknown"; desc?: string }
		| { k: "null"; desc?: string }
		| { k: "undefined"; desc?: string }
		| { k: "boolean"; desc?: string }
		| { k: "bigint"; desc?: string }
		| { k: "symbol"; desc?: string }
		| { k: "never"; desc?: string }
		/** Any non-null object (the bare `object` keyword). */
		| { k: "anyobject"; desc?: string }
		| { k: "string"; min?: number; max?: number; url?: boolean; desc?: string }
		| {
				k: "number";
				min?: number;
				max?: number;
				xmin?: boolean;
				xmax?: boolean;
				int?: boolean;
				divisor?: number;
				desc?: string;
		  }
		| { k: "lit"; v: unknown; desc?: string }
		| { k: "union"; members: IR[]; desc?: string }
		| { k: "intersection"; members: IR[]; desc?: string }
		| { k: "array"; el: IR; min?: number; max?: number; desc?: string }
		| TupleIR
		| { k: "object"; props: PropIR[]; index?: IR; extras: Extras; desc?: string }
		| {
				k: "refine";
				base: IR;
				pred: (value: unknown) => boolean;
				expected: string;
				json?: Record<string, unknown>;
				desc?: string;
		  }
		| {
				k: "morph";
				input: IR;
				fn: (value: unknown, context: MorphContext) => unknown;
				out?: IR;
				desc?: string;
		  }
		| { k: "instance"; ctor: Constructor; expected: string; desc?: string }
		| { k: "alias"; name: string; resolve: () => IR; desc?: string }
		/** Embedded schema with runtime steps; validated by calling `run`. */
		| { k: "sub"; schema: EmbeddableSchema; desc?: string }
	);

export interface PropIR {
	key: string;
	opt: boolean;
	val: IR;
	/** Default payload (value, or factory when `defFactory`); missing key is filled. */
	def?: unknown;
	defFactory?: boolean;
	hasDefault?: boolean;
}

/** Definition input accepted by `type()` and object property values. */
export type Def = string | RegExp | Date | EmbeddableSchema | readonly unknown[] | { readonly [k: string]: unknown };

// ── tokenizer ────────────────────────────────────────────────────────────────

type Tok =
	| { t: "id"; v: string }
	| { t: "num"; v: number }
	| { t: "date"; v: Date }
	| { t: "str"; v: string }
	| { t: "op"; v: string };

const SIMPLE_OPS = "|()[]=?%";

function tokenize(src: string): Tok[] {
	const toks: Tok[] = [];
	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		if (c === "'" || c === '"') {
			let j = i + 1;
			while (j < n && src[j] !== c) j++;
			if (j >= n) throw new OmpTypeError(`unterminated string literal in "${src}"`);
			toks.push({ t: "str", v: src.slice(i + 1, j) });
			i = j + 1;
			continue;
		}
		if (c === "d" && (src[i + 1] === "'" || src[i + 1] === '"')) {
			const quote = src[i + 1];
			const end = src.indexOf(quote, i + 2);
			if (end < 0) throw new OmpTypeError(`unterminated date literal in "${src}"`);
			const value = new Date(src.slice(i + 2, end));
			if (Number.isNaN(value.valueOf())) throw new OmpTypeError(`invalid date literal in "${src}"`);
			toks.push({ t: "date", v: value });
			i = end + 1;
			continue;
		}
		if ((c >= "0" && c <= "9") || (c === "-" && i + 1 < n && src[i + 1] >= "0" && src[i + 1] <= "9")) {
			let j = i + 1;
			while (j < n && ((src[j] >= "0" && src[j] <= "9") || src[j] === "." || src[j] === "e" || src[j] === "+")) j++;
			toks.push({ t: "num", v: Number(src.slice(i, j)) });
			i = j;
			continue;
		}
		if (/[a-zA-Z_$]/.test(c)) {
			let j = i + 1;
			while (j < n && /[\w.$]/.test(src[j])) j++;
			toks.push({ t: "id", v: src.slice(i, j) });
			i = j;
			continue;
		}
		if (c === "<" || c === ">") {
			if (src[i + 1] === "=") {
				toks.push({ t: "op", v: `${c}=` });
				i += 2;
			} else {
				toks.push({ t: "op", v: c });
				i++;
			}
			continue;
		}
		if (SIMPLE_OPS.includes(c)) {
			toks.push({ t: "op", v: c });
			i++;
			continue;
		}
		throw new OmpTypeError(`unexpected character '${c}' in "${src}"`);
	}
	return toks;
}

// ── string-definition parser ─────────────────────────────────────────────────

const CMP: Record<string, true> = { "<": true, "<=": true, ">": true, ">=": true };

const KEYWORDS: Record<string, () => IR> = {
	number: () => ({ k: "number" }),
	"number.integer": () => ({ k: "number", int: true }),
	boolean: () => ({ k: "boolean" }),
	bigint: () => ({ k: "bigint" }),
	symbol: () => ({ k: "symbol" }),
	never: () => ({ k: "never" }),
	null: () => ({ k: "null" }),
	undefined: () => ({ k: "undefined" }),
	unknown: () => ({ k: "unknown" }),
	any: () => ({ k: "unknown" }),
	object: () => ({ k: "anyobject" }),
	Date: () => ({ k: "instance", ctor: Date, expected: "a Date" }),
	true: () => ({ k: "lit", v: true }),
	false: () => ({ k: "lit", v: false }),
};

/** Resolve a named scope alias to its lazy IR reference. */
export type AliasResolver = (name: string) => IR | undefined;

interface ParsedTop {
	ir: IR;
	def?: unknown;
	hasDefault: boolean;
	/** Trailing `?` marker — only legal on object property values. */
	optional: boolean;
}

class StrParser {
	#toks: Tok[];
	#pos = 0;
	#src: string;
	#resolve: AliasResolver | undefined;

	constructor(src: string, resolve?: AliasResolver) {
		this.#src = src;
		this.#resolve = resolve;
		this.#toks = tokenize(src);
	}

	#peek(offset = 0): Tok | undefined {
		return this.#toks[this.#pos + offset];
	}

	#next(): Tok {
		const t = this.#toks[this.#pos++];
		if (!t) throw new OmpTypeError(`unexpected end of definition "${this.#src}"`);
		return t;
	}

	#eatOp(v: string): boolean {
		const t = this.#peek();
		if (t?.t === "op" && t.v === v) {
			this.#pos++;
			return true;
		}
		return false;
	}

	/** Full definition with optional trailing `= literal` default and/or `?` optional marker. */
	parseTop(): ParsedTop {
		const ir = this.parseUnion();
		let def: unknown;
		let hasDefault = false;
		if (this.#eatOp("=")) {
			const t = this.#next();
			if (t.t === "num" || t.t === "str") def = t.v;
			else if (t.t === "id" && (t.v === "true" || t.v === "false")) def = t.v === "true";
			else if (t.t === "id" && t.v === "null") def = null;
			else throw new OmpTypeError(`unsupported default literal in "${this.#src}"`);
			hasDefault = true;
		}
		const optional = this.#eatOp("?");
		this.#expectEnd();
		return { ir, def, hasDefault, optional };
	}

	#expectEnd(): void {
		if (this.#pos < this.#toks.length) {
			throw new OmpTypeError(`trailing tokens in definition "${this.#src}"`);
		}
	}

	parseUnion(): IR {
		const first = this.parseBounded();
		if (!this.#eatOp("|")) return first;
		const members = [first, this.parseBounded()];
		while (this.#eatOp("|")) members.push(this.parseBounded());
		return { k: "union", members };
	}

	/**
	 * `NUM CMP base (CMP NUM)?` or `base (CMP NUM)?`, with `[]*` postfix on the
	 * base AND after a trailing bound — `string>0[]` is an array of bounded
	 * strings, matching ArkType precedence (bounds bind tighter than `[]`).
	 */
	parseBounded(): IR {
		const t = this.#peek();
		const t1 = this.#peek(1);
		if ((t?.t === "num" || t?.t === "date") && t1?.t === "op" && CMP[t1.v]) {
			const lo = t.v;
			this.#pos += 2;
			let node = this.#eatDivisor(this.parsePostfix());
			node = applyBound(node, flip(t1.v), lo, this.#src);
			const t2 = this.#peek();
			if (t2?.t === "op" && CMP[t2.v]) {
				this.#pos++;
				const hi = this.#next();
				if (hi.t !== "num" && hi.t !== "date") {
					throw new OmpTypeError(`expected bound after comparator in "${this.#src}"`);
				}
				node = applyBound(node, t2.v, hi.v, this.#src);
			}
			return this.#eatArraySuffixes(node);
		}
		let node = this.#eatDivisor(this.parsePostfix());
		const t2 = this.#peek();
		if (t2?.t === "op" && CMP[t2.v]) {
			this.#pos++;
			const limit = this.#next();
			if (limit.t !== "num" && limit.t !== "date") {
				throw new OmpTypeError(`expected bound after comparator in "${this.#src}"`);
			}
			node = applyBound(node, t2.v, limit.v, this.#src);
			node = this.#eatArraySuffixes(node);
		}
		return node;
	}

	#eatDivisor(node: IR): IR {
		if (!this.#eatOp("%")) return node;
		const divisor = this.#next();
		if (divisor.t !== "num") throw new OmpTypeError(`expected number after % in "${this.#src}"`);
		if (node.k !== "number") throw new OmpTypeError(`% requires number in "${this.#src}"`);
		if (!Number.isFinite(divisor.v) || divisor.v === 0)
			throw new OmpTypeError(`divisor must be non-zero in "${this.#src}"`);
		node.divisor = divisor.v;
		return node;
	}

	/** Wrap `node` in array IR for each `[]` pair at the cursor. */
	#eatArraySuffixes(node: IR): IR {
		for (;;) {
			const t = this.#peek();
			if (!(t?.t === "op" && t.v === "[")) return node;
			this.#pos++;
			if (!this.#eatOp("]")) throw new OmpTypeError(`expected ']' in "${this.#src}"`);
			node = { k: "array", el: node };
		}
	}

	parsePostfix(): IR {
		let node = this.parsePrimary();
		for (;;) {
			const t = this.#peek();
			if (!(t?.t === "op" && t.v === "[")) break;
			this.#pos++;
			if (!this.#eatOp("]")) throw new OmpTypeError(`expected ']' in "${this.#src}"`);
			node = { k: "array", el: node };
		}
		return node;
	}

	parsePrimary(): IR {
		const t = this.#next();
		if (t.t === "op" && t.v === "(") {
			const inner = this.parseUnion();
			if (!this.#eatOp(")")) throw new OmpTypeError(`expected ')' in "${this.#src}"`);
			return inner;
		}
		if (t.t === "str" || t.t === "num" || t.t === "date") return { k: "lit", v: t.v };
		if (t.t === "id") {
			const make = KEYWORDS[t.v];
			const keyword = make?.() ?? keywordIR(t.v) ?? this.#resolve?.(t.v);
			if (!keyword) throw new OmpTypeError(`unknown keyword "${t.v}" in "${this.#src}"`);
			return keyword;
		}
		throw new OmpTypeError(`unexpected token in "${this.#src}"`);
	}
}

const STRING_DEF_CACHE_MAX = 1_024;
const stringDefCache = new Map<string, ParsedTop>();

/** Fast path for the literal unions pervasive in command schemas. */
function parseLiteralUnion(src: string): IR | undefined {
	const members: IR[] = [];
	let index = 0;
	while (index < src.length && /\s/.test(src[index])) index++;
	for (;;) {
		const quote = src[index];
		if (quote !== "'" && quote !== '"') return undefined;
		const end = src.indexOf(quote, index + 1);
		if (end < 0) return undefined;
		members.push({ k: "lit", v: src.slice(index + 1, end) });
		index = end + 1;
		while (index < src.length && /\s/.test(src[index])) index++;
		if (index === src.length) {
			return members.length === 1 ? members[0] : { k: "union", members };
		}
		if (src[index] !== "|") return undefined;
		index++;
		while (index < src.length && /\s/.test(src[index])) index++;
	}
}

function genericArguments(src: string): { name: string; args: string[] } | undefined {
	const open = src.indexOf("<");
	if (open < 1 || !src.endsWith(">")) return undefined;
	const name = src.slice(0, open).trim();
	const body = src.slice(open + 1, -1);
	const args: string[] = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	for (let index = 0; index < body.length; index++) {
		const char = body[index];
		if (quote !== "") {
			if (char === quote && body[index - 1] !== "\\") quote = "";
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
		} else if (char === "<" || char === "(" || char === "[") {
			depth++;
		} else if (char === ">" || char === ")" || char === "]") {
			depth--;
		} else if (char === "," && depth === 0) {
			args.push(body.slice(start, index).trim());
			start = index + 1;
		}
	}
	args.push(body.slice(start).trim());
	return { name, args };
}

function genericKeys(ir: IR): Set<string> {
	const keys = new Set<string>();
	const visit = (node: IR): void => {
		if (node.k === "lit" && typeof node.v === "string") keys.add(node.v);
		else if (node.k === "union") for (const member of node.members) visit(member);
	};
	visit(ir);
	return keys;
}

function resolveStructuralIR(ir: IR): IR {
	const seen = new Set<IR>();
	while (ir.k === "alias") {
		if (seen.has(ir)) throw new OmpTypeError(`cannot structurally transform recursive alias "${ir.name}"`);
		seen.add(ir);
		ir = ir.resolve();
	}
	return ir;
}

function mergeObjectIR(left: IR, right: IR): IR {
	left = resolveStructuralIR(left);
	right = resolveStructuralIR(right);
	if (left.k !== "object" || right.k !== "object") {
		throw new OmpTypeError("Merge requires object arguments");
	}
	const props = [...left.props];
	for (const prop of right.props) {
		const index = props.findIndex(candidate => candidate.key === prop.key);
		if (index < 0) props.push(prop);
		else props[index] = prop;
	}
	return {
		k: "object",
		props,
		index: right.index ?? left.index,
		extras: right.extras === "keep" ? left.extras : right.extras,
	};
}

function parseGeneric(src: string, resolve?: AliasResolver): IR | undefined {
	const generic = genericArguments(src);
	if (generic === undefined) return undefined;
	if (generic.name === "Record" && generic.args.length === 2) {
		return { k: "object", props: [], index: parseDef(generic.args[1], resolve), extras: "keep" };
	}
	if ((generic.name === "Partial" || generic.name === "Required") && generic.args.length === 1) {
		const object = resolveStructuralIR(parseDef(generic.args[0], resolve));
		if (object.k !== "object") throw new OmpTypeError(`${generic.name} requires an object`);
		const optional = generic.name === "Partial";
		return { ...object, props: object.props.map(prop => ({ ...prop, opt: optional })) };
	}
	if ((generic.name === "Pick" || generic.name === "Omit") && generic.args.length === 2) {
		const object = resolveStructuralIR(parseDef(generic.args[0], resolve));
		if (object.k !== "object") throw new OmpTypeError(`${generic.name} requires an object`);
		const keys = genericKeys(parseDef(generic.args[1], resolve));
		const pick = generic.name === "Pick";
		return { ...object, props: object.props.filter(prop => keys.has(prop.key) === pick) };
	}
	if (generic.name === "Merge" && generic.args.length === 2) {
		return mergeObjectIR(parseDef(generic.args[0], resolve), parseDef(generic.args[1], resolve));
	}
	return undefined;
}

function dateLiteral(source: string): Date {
	const value = new Date(source);
	if (!Number.isFinite(value.valueOf())) throw new OmpTypeError(`invalid Date literal "${source}"`);
	return value;
}

function parseDateExpression(src: string): IR | undefined {
	const literal = src.match(/^d(['"])(.*)\1$/);
	if (literal) return { k: "lit", v: dateLiteral(literal[2]) };
	const forward = src.match(/^Date\s*(<=|<|>=|>)\s*d(['"])(.*)\2$/);
	const reverse = src.match(/^d(['"])(.*)\1\s*(<=|<|>=|>)\s*Date$/);
	if (!forward && !reverse) return undefined;
	const bound = dateLiteral(forward ? forward[3] : (reverse?.[2] ?? ""));
	const operator = forward
		? forward[1]
		: reverse?.[3] === "<="
			? ">="
			: reverse?.[3] === "<"
				? ">"
				: reverse?.[3] === ">="
					? "<="
					: "<";
	const timestamp = bound.valueOf();
	const relation =
		operator === ">="
			? "at or after"
			: operator === ">"
				? "later than"
				: operator === "<="
					? "at or before"
					: "earlier than";
	return {
		k: "refine",
		base: { k: "instance", ctor: Date, expected: "a Date" },
		pred: value => {
			if (!(value instanceof Date)) return false;
			const actual = value.valueOf();
			return operator === ">="
				? actual >= timestamp
				: operator === ">"
					? actual > timestamp
					: operator === "<="
						? actual <= timestamp
						: actual < timestamp;
		},
		expected: `a Date ${relation} ${bound.toISOString()}`,
		json: operator === ">=" || operator === ">" ? { minimum: bound.toISOString() } : { maximum: bound.toISOString() },
	};
}

/** Parse recurring global DSL fragments once; scoped aliases bypass the cache. */
function parseStringDef(src: string, resolve?: AliasResolver): ParsedTop {
	if (resolve === undefined) {
		const cached = stringDefCache.get(src);
		if (cached) return cached;
	}
	let ir = parseDateExpression(src) ?? parseLiteralUnion(src) ?? parseGeneric(src, resolve);
	if (ir === undefined && src.startsWith("`") && src.endsWith("`")) {
		ir = templateIR(src.slice(1, -1));
	} else if (ir === undefined && src.startsWith("/") && src.lastIndexOf("/") > 0) {
		const end = src.lastIndexOf("/");
		try {
			ir = patternIR(new RegExp(src.slice(1, end), src.slice(end + 1)));
		} catch {
			throw new OmpTypeError(`invalid regular expression "${src}"`);
		}
	}
	const parsed: ParsedTop =
		ir === undefined ? new StrParser(src, resolve).parseTop() : { ir, hasDefault: false, optional: false };
	if (resolve === undefined && stringDefCache.size < STRING_DEF_CACHE_MAX) stringDefCache.set(src, parsed);
	return parsed;
}

function flip(op: string): string {
	switch (op) {
		case "<":
			return ">";
		case "<=":
			return ">=";
		case ">":
			return "<";
		default:
			return "<=";
	}
}

/** Apply `node CMP value` — numeric/string/array ranges or Date bounds. */
function applyBound(node: IR, op: string, value: number | Date, src: string): IR {
	if (value instanceof Date) {
		if (!acceptsDate(node)) throw new OmpTypeError(`date bound requires Date in "${src}"`);
		const limit = value.valueOf();
		const relation =
			op === ">=" ? "on or after" : op === ">" ? "later than" : op === "<=" ? "on or before" : "earlier than";
		return {
			k: "refine",
			base: node,
			pred: input => {
				if (!(input instanceof Date)) return false;
				const time = input.valueOf();
				return op === ">=" ? time >= limit : op === ">" ? time > limit : op === "<=" ? time <= limit : time < limit;
			},
			expected: `a Date ${relation} ${value.toISOString()}`,
		};
	}
	if (node.k === "number") {
		switch (op) {
			case ">=":
				node.min = value;
				node.xmin = false;
				break;
			case ">":
				node.min = value;
				node.xmin = true;
				break;
			case "<=":
				node.max = value;
				node.xmax = false;
				break;
			case "<":
				node.max = value;
				node.xmax = true;
				break;
		}
		return node;
	}
	if (node.k === "string" || node.k === "array") {
		switch (op) {
			case ">=":
				node.min = value;
				break;
			case ">":
				node.min = value + 1;
				break;
			case "<=":
				node.max = value;
				break;
			case "<":
				node.max = value - 1;
				break;
		}
		return node;
	}
	throw new OmpTypeError(`cannot bound ${node.k} in "${src}"`);
}

function acceptsDate(node: IR): boolean {
	return (node.k === "instance" && node.ctor === Date) || (node.k === "refine" && acceptsDate(node.base));
}

// ── definition parser ────────────────────────────────────────────────────────

function isEmbedded(def: unknown): def is EmbeddableSchema {
	return (typeof def === "function" || (typeof def === "object" && def !== null)) && IR_BRAND in def;
}

/** Embed a schema value: inline pure structure, keep `sub` nodes for stepped schemas. */
export function embed(schema: EmbeddableSchema): IR {
	if (schema.hasSteps) return { k: "sub", schema, desc: schema.description };
	if (schema.description !== undefined && schema.ir.desc === undefined) {
		return { ...schema.ir, desc: schema.description };
	}
	return schema.ir;
}

function isCallback(value: unknown): value is (input: unknown, context: MorphContext) => unknown {
	return typeof value === "function";
}

function isConstructor(value: unknown): value is Constructor {
	return typeof value === "function" && value.prototype !== undefined;
}

function parseTupleItem(def: unknown, resolve?: AliasResolver): TupleItemIR {
	if (Array.isArray(def) && def.length === 2 && def[1] === "?") {
		return { val: parseDef(def[0], resolve), opt: true };
	}
	if (Array.isArray(def) && def.length === 3 && def[1] === "=") {
		return {
			val: parseDef(def[0], resolve),
			opt: true,
			def: def[2],
			defFactory: typeof def[2] === "function",
			hasDefault: true,
		};
	}
	return { val: parseDef(def, resolve), opt: false };
}

function parseTuple(def: readonly unknown[], resolve?: AliasResolver): TupleIR {
	const prefix: TupleItemIR[] = [];
	const postfix: IR[] = [];
	let variadic: IR | undefined;
	let optionalSeen = false;
	for (let index = 0; index < def.length; index++) {
		if (def[index] === "...") {
			if (variadic !== undefined || index + 1 >= def.length) {
				throw new OmpTypeError("a tuple may have one spread followed by an array definition");
			}
			const spread = parseDef(def[++index], resolve);
			if (spread.k !== "array") throw new OmpTypeError("tuple spread element must be an array");
			variadic = spread.el;
			continue;
		}
		if (variadic !== undefined) {
			const item = parseTupleItem(def[index], resolve);
			if (item.opt || item.hasDefault) {
				throw new OmpTypeError("optional tuple elements cannot follow a variadic element");
			}
			postfix.push(item.val);
			continue;
		}
		const item = parseTupleItem(def[index], resolve);
		if (optionalSeen && !item.opt && !item.hasDefault) {
			throw new OmpTypeError("required tuple elements cannot follow optional elements");
		}
		optionalSeen ||= item.opt || item.hasDefault === true;
		prefix.push(item);
	}
	return { k: "tuple", prefix, variadic, postfix };
}

/** Build the runtime schema for an object's or tuple's keys. */
export function keyOf(node: IR): IR {
	if (node.k === "object") {
		const members: IR[] = node.props.map(prop => ({ k: "lit", v: prop.key }));
		if (node.index !== undefined) members.push({ k: "string" });
		if (members.length === 0) return { k: "never" };
		return members.length === 1 ? members[0] : { k: "union", members };
	}
	if (node.k === "tuple") return { k: "number", int: true, min: 0 };
	throw new OmpTypeError(`keyof requires an object or tuple (was ${node.k})`);
}

function parseArrayExpression(def: readonly unknown[], resolve?: AliasResolver): IR {
	if (def.length === 2 && def[1] === "[]") return { k: "array", el: parseDef(def[0], resolve) };
	if (def.length === 2 && def[0] === "keyof") return keyOf(parseDef(def[1], resolve));
	if (def[0] === "instanceof") {
		const members: IR[] = [];
		for (let index = 1; index < def.length; index++) {
			const ctor = def[index];
			if (!isConstructor(ctor)) throw new OmpTypeError("instanceof operands must be constructors");
			members.push({ k: "instance", ctor, expected: `an instance of ${ctor.name || "the constructor"}` });
		}
		return members.length === 1 ? members[0] : { k: "union", members };
	}
	if (def[0] === "===") {
		const members = def.slice(1).map(value => ({ k: "lit", v: value }) satisfies IR);
		if (members.length === 0) return { k: "never" };
		return members.length === 1 ? members[0] : { k: "union", members };
	}
	if (def.length >= 3 && def[1] === "|") {
		return { k: "union", members: [parseDef(def[0], resolve), parseDef(def[2], resolve)] };
	}
	if (def.length >= 3 && def[1] === "&") {
		return { k: "intersection", members: [parseDef(def[0], resolve), parseDef(def[2], resolve)] };
	}
	if (def.length === 3 && def[1] === "=>") {
		if (!isCallback(def[2])) throw new OmpTypeError("morph operator requires a function");
		return { k: "morph", input: parseDef(def[0], resolve), fn: def[2] };
	}
	if (def.length === 3 && def[1] === "|>") {
		return { k: "morph", input: parseDef(def[0], resolve), fn: value => value, out: parseDef(def[2], resolve) };
	}
	if (def.length === 3 && def[1] === ":") {
		if (!isCallback(def[2])) throw new OmpTypeError("narrow operator requires a predicate");
		const predicate = def[2];
		return {
			k: "refine",
			base: parseDef(def[0], resolve),
			pred: value =>
				predicate(value, {
					error: () => OmpErrors.single([], "the predicate", value),
					reject: () => OmpErrors.single([], "the predicate", value),
				}) === true,
			expected: "a value satisfying the predicate",
		};
	}
	if (def.length >= 3 && def[1] === "@") {
		const base = parseDef(def[0], resolve);
		const meta = def[2];
		if (typeof meta === "string") return { ...base, desc: meta };
		if (typeof meta === "object" && meta !== null && "description" in meta && typeof meta.description === "string") {
			return { ...base, desc: meta.description };
		}
		return base;
	}
	return parseTuple(def, resolve);
}

/** Parse a definition, optionally resolving names from an enclosing scope. */
export function parseDef(def: unknown, resolve?: AliasResolver): IR {
	if (typeof def === "string") {
		const parsed = parseStringDef(def, resolve);
		if (parsed.optional) {
			throw new OmpTypeError(`optional "?" marker is only valid on object property values`);
		}
		return parsed.ir;
	}
	if (isEmbedded(def)) return embed(def);
	if (def instanceof RegExp) return patternIR(def);
	if (def instanceof Date) return { k: "lit", v: def };
	if (Array.isArray(def)) return parseArrayExpression(def, resolve);
	if (typeof def === "object" && def !== null) {
		const props: PropIR[] = [];
		let index: IR | undefined;
		let extras: Extras = "keep";
		for (const rawKey in def) {
			const val: unknown = Reflect.get(def, rawKey);
			if (rawKey === "+") {
				if (val === "reject" || val === "delete") extras = val;
				else if (val === "ignore") extras = "keep";
				else throw new OmpTypeError(`bad "+" value ${String(val)}`);
				continue;
			}
			if (rawKey === "...") {
				const spread = parseDef(val, resolve);
				if (spread.k !== "object") throw new OmpTypeError("object spread must resolve to an object");
				for (const prop of spread.props) {
					const previous = props.findIndex(candidate => candidate.key === prop.key);
					if (previous < 0) props.push(prop);
					else props[previous] = prop;
				}
				index ??= spread.index;
				if (spread.extras !== "keep") extras = spread.extras;
				continue;
			}
			if (rawKey === "[string]") {
				index = parseDef(val, resolve);
				continue;
			}
			const opt = rawKey.endsWith("?");
			const key = opt ? rawKey.slice(0, -1) : rawKey;
			if (typeof val === "string") {
				const parsed = parseStringDef(val, resolve);
				const prop: PropIR = { key, opt: opt || parsed.optional, val: parsed.ir };
				if (parsed.hasDefault) {
					prop.def = parsed.def;
					prop.hasDefault = true;
				}
				props.push(prop);
			} else if (Array.isArray(val) && val.length === 2 && val[1] === "?") {
				props.push({ key, opt: true, val: parseDef(val[0], resolve) });
			} else if (Array.isArray(val) && val.length === 3 && val[1] === "=") {
				props.push({
					key,
					opt,
					val: parseDef(val[0], resolve),
					def: val[2],
					defFactory: typeof val[2] === "function",
					hasDefault: true,
				});
			} else if (isEmbedded(val) && val.hasDefault) {
				props.push({
					key,
					opt,
					val: embed(val),
					def: val.defaultValue,
					defFactory: typeof val.defaultValue === "function",
					hasDefault: true,
				});
			} else {
				props.push({ key, opt, val: parseDef(val, resolve) });
			}
		}
		return { k: "object", props, index, extras };
	}
	throw new OmpTypeError(`unsupported definition ${String(def)}`);
}

/** True when validating `ir` can produce an output different from its input. */
export function hasMorph(ir: IR): boolean {
	const cached = ir[kMorph];
	if (cached !== undefined) return cached;

	let result = false;
	switch (ir.k) {
		case "sub":
			result = true;
			break;
		case "morph":
		case "alias":
			result = true;
			break;
		case "object":
			result = ir.extras === "delete";
			for (let i = 0; !result && i < ir.props.length; i++) {
				const prop = ir.props[i];
				result = prop.hasDefault === true || hasMorph(prop.val);
			}
			if (!result && ir.index !== undefined) result = hasMorph(ir.index);
			break;
		case "array":
			result = hasMorph(ir.el);
			break;
		case "union":
			result = ir.members.some(hasMorph);
			break;
		case "intersection":
			result = ir.members.some(hasMorph);
			break;
		case "refine":
			result = hasMorph(ir.base);
			break;
		case "tuple":
			result =
				ir.prefix.some(item => item.hasDefault === true || hasMorph(item.val)) ||
				(ir.variadic !== undefined && hasMorph(ir.variadic)) ||
				ir.postfix.some(hasMorph);
			break;
	}
	ir[kMorph] = result;
	return result;
}

/** Human-readable expectation for error messages, e.g. `"a string"`. */
export function expectedOf(ir: IR): string {
	switch (ir.k) {
		case "unknown":
			return "unknown";
		case "null":
			return "null";
		case "undefined":
			return "undefined";
		case "boolean":
			return "boolean";
		case "bigint":
			return "a bigint";
		case "symbol":
			return "a symbol";
		case "never":
			return "never";
		case "anyobject":
			return "an object";
		case "string": {
			let out = ir.url ? "a URL string" : "a string";
			if (ir.min !== undefined && ir.max !== undefined) out += ` (length ${ir.min} to ${ir.max})`;
			else if (ir.min !== undefined) out += ` (length at least ${ir.min})`;
			else if (ir.max !== undefined) out += ` (length at most ${ir.max})`;
			return out;
		}
		case "number": {
			let out = ir.int ? "an integer" : "a number";
			if (ir.min !== undefined) out += ` ${ir.xmin ? "more than" : "at least"} ${ir.min}`;
			if (ir.max !== undefined)
				out += `${ir.min !== undefined ? " and" : ""} ${ir.xmax ? "less than" : "at most"} ${ir.max}`;
			if (ir.divisor !== undefined) out += ` divisible by ${ir.divisor}`;
			return out;
		}
		case "lit":
			return ir.v instanceof Date
				? `the date ${ir.v.toISOString()}`
				: typeof ir.v === "string"
					? JSON.stringify(ir.v)
					: String(ir.v);
		case "union": {
			if (ir.members.length === 0) return "";
			const first = expectedOf(ir.members[0]);
			if (ir.members.length === 1) return first;
			const second = expectedOf(ir.members[1]);
			if (ir.members.length === 2) return first === second ? first : `${first} or ${second}`;
			const expectations = first === second ? [first] : [first, second];
			for (let i = 2; i < ir.members.length; i++) {
				const expected = expectedOf(ir.members[i]);
				if (!expectations.includes(expected)) expectations.push(expected);
			}
			return expectations.join(" or ");
		}
		case "intersection":
			return ir.members.map(expectedOf).join(" and ");
		case "array":
			return "an array";
		case "tuple":
			return "a tuple";
		case "object":
			return "an object";
		case "instance":
			return ir.expected;
		case "refine":
			return ir.expected;
		case "morph":
			return expectedOf(ir.input);
		case "alias":
			return ir.name;
		case "sub":
			return expectedOf(ir.schema.ir);
	}
}
