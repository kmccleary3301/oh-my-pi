/**
 * The public `type()` parser and `Type` schema surface — an ArkType-compatible
 * validator with a lazy JIT:
 *
 * - calls 1-2 run the tree-walking interpreter (near-zero setup cost, so
 *   schemas built per-request or validated once stay cheap)
 * - the third call compiles a specialized validator via `new Function` and
 *   swaps it in; hot schemas validate in tens of nanoseconds
 *
 * A schema is a callable: `schema(data)` returns the (possibly morphed)
 * output, or an `OmpErrors` on failure (`result instanceof type.errors`).
 */
import { compile } from "./compile";
import { type ErrorConfig, OmpErrors, OmpTypeError, TraversalError } from "./errors";
import type { InferDef, InferDefIn, InferObjectLiteral, InferString } from "./infer";
import { walk } from "./interp";
import {
	type AliasResolver,
	type Constructor,
	type Def,
	embed,
	expectedOf,
	hasMorph,
	type IR,
	IR_BRAND,
	keyOf,
	type PropIR,
	parseDef,
} from "./ir";
import { irToJsonSchema, type JsonSchemaOptions } from "./json-schema";
import { keywordIR, patternIR } from "./keywords";

/** Context passed to `.narrow()` / `.pipe()` callbacks. */
export interface NarrowContext {
	/** Record `must be <expectation>` and signal failure. */
	mustBe(expectation: string): false;
	/** Record a custom problem and signal failure. */
	reject(problem: string): false;
}

/** Schema metadata and validation-message overrides accepted by `.configure()`. */
export interface SchemaConfig extends ErrorConfig {
	readonly description?: string;
}

/** Options accepted by `Type.toJsonSchema`. */
export interface ToJsonSchemaOptions extends JsonSchemaOptions {}

declare const brand: unique symbol;

/** Inference-only nominal brand attached by `.brand(name)`. */
export type Brand<t, name extends string> = t & { readonly [brand]: name };

interface SchemaInference<out t, i = t> {
	readonly [IR_BRAND]: true;
	readonly infer: t;
	readonly inferIn: i;
}

/** Property descriptor exposed by object schemas and consumed by `.map()`. */
export interface TypeProperty {
	readonly kind: "required" | "optional";
	readonly key: PropertyKey;
	readonly value: FluentType<unknown>;
	readonly default?: unknown;
	readonly meta: Readonly<Record<string, unknown>>;
}

/** Structural node returned by `.select()`. */
export interface SelectedNode {
	readonly kind: string;
	readonly node: IR;
	readonly unit?: unknown;
}

/** A compiled schema: callable validator plus composition methods. */
export interface Type<out t = unknown, i = t> {
	(data: unknown): t | OmpErrors;
	readonly [IR_BRAND]: true;
	/** Structural IR (base type; runtime steps live in `steps`). */
	readonly ir: IR;
	/** `.pipe()` / `.narrow()` steps applied after structural validation. */
	readonly hasSteps: boolean;
	readonly hasDefault: boolean;
	readonly defaultValue?: unknown;
	readonly description?: string;
	/** Full validate+morph pipeline; identical to calling the schema. */
	readonly run: (data: unknown) => unknown;

	/** Inference-only output type (no runtime value). */
	readonly infer: t;
	/** Inference-only input type (no runtime value). */
	readonly inferIn: i;

	/** Structural + narrow check without running pipes. */
	allows(data: unknown): data is i;
	/** Validate and return output, throwing `TraversalError` on failure. */
	assert(data: unknown): t;
	/** Validate a statically typed input and return its output. */
	from(data: i): t;
	/** JSON Schema for this schema's structural base. */
	toJsonSchema(options?: ToJsonSchemaOptions): Record<string, unknown>;
}

type MergeTypes<left, right> = left extends object
	? right extends object
		? Omit<left, keyof right> & right
		: right
	: right;

interface FluentMethods<t, i> {
	describe(description: string): FluentType<t, i>;
	configure(config: SchemaConfig): FluentType<t, i>;
	default(value: t | (() => t)): FluentType<t, i>;
	optional(): readonly [SchemaInference<t, i>, "?"];
	or<r, ri>(def: SchemaInference<r, ri>): FluentType<t | r, i | ri>;
	or<const def extends string>(def: def): FluentType<t | InferString<def>, i | InferString<def>>;
	or<const def extends Record<string, unknown>>(
		def: def,
	): FluentType<t | InferObjectLiteral<def>, i | InferObjectLiteral<def>>;
	or(def: Def): FluentType<unknown>;
	and<r, ri>(def: SchemaInference<r, ri>): FluentType<t & r, i & ri>;
	and<const def extends Record<string, unknown>>(
		def: def,
	): FluentType<t & InferObjectLiteral<def>, i & InferObjectLiteral<def>>;
	and(def: Def): FluentType<unknown>;
	equals(def: Def): boolean;
	ifEquals(def: Def): FluentType<t, i> | undefined;
	extends(def: Def): boolean;
	overlaps(def: Def): boolean;
	distribute<r>(mapper: (branch: FluentType<unknown>) => SchemaInference<r>): FluentType<r>;
	select(kind: string): readonly SelectedNode[];
	array(): FluentType<t[], i[]>;
	atLeastLength(bound: number): FluentType<t, i>;
	atMostLength(bound: number): FluentType<t, i>;
	moreThanLength(bound: number): FluentType<t, i>;
	lessThanLength(bound: number): FluentType<t, i>;
	exactlyLength(bound: number): FluentType<t, i>;
	atLeast(bound: number): FluentType<t, i>;
	atMost(bound: number): FluentType<t, i>;
	moreThan(bound: number): FluentType<t, i>;
	lessThan(bound: number): FluentType<t, i>;
	divisibleBy(divisor: number): FluentType<t, i>;
	positive(): FluentType<t, i>;
	negative(): FluentType<t, i>;
	nonNegative(): FluentType<t, i>;
	nonPositive(): FluentType<t, i>;
	matching(pattern: RegExp): FluentType<t, i>;
	atOrAfter(bound: Date): FluentType<t, i>;
	atOrBefore(bound: Date): FluentType<t, i>;
	laterThan(bound: Date): FluentType<t, i>;
	earlierThan(bound: Date): FluentType<t, i>;
	pipe<r>(fn: (data: t, ctx: NarrowContext) => r): FluentType<Exclude<r, OmpErrors>, i>;
	to<const def>(def: def): FluentType<InferDef<def>, i>;
	filter<narrowed extends i>(fn: (data: i, ctx: NarrowContext) => data is narrowed): FluentType<t, narrowed>;
	filter(fn: (data: i, ctx: NarrowContext) => boolean): FluentType<t, i>;
	narrow<narrowed extends t>(fn: (data: t, ctx: NarrowContext) => data is narrowed): FluentType<narrowed, i>;
	narrow(fn: (data: t, ctx: NarrowContext) => boolean): FluentType<t, i>;
	brand<const name extends string>(name: name): FluentType<Brand<t, name>, i>;
	as<castTo>(): FluentType<castTo, i>;
	extract<r, ri>(def: SchemaInference<r, ri>): FluentType<Extract<t, r>, Extract<i, ri>>;
	extract<const def extends string>(def: def): FluentType<Extract<t, InferString<def>>, Extract<i, InferString<def>>>;
	extract(def: Def): FluentType<unknown>;
	exclude<r, ri>(def: SchemaInference<r, ri>): FluentType<Exclude<t, r>, Exclude<i, ri>>;
	exclude<const def extends string>(def: def): FluentType<Exclude<t, InferString<def>>, Exclude<i, InferString<def>>>;
	exclude(def: Def): FluentType<unknown>;
	onUndeclaredKey(behavior: "ignore" | "reject" | "delete"): FluentType<t, i>;
	onDeepUndeclaredKey(behavior: "ignore" | "reject" | "delete"): FluentType<t, i>;
}

type InputObject<i> = i extends object ? i : object;

interface ObjectMethods<t extends object, i> {
	readonly props: readonly TypeProperty[];
	map(
		mapper: (property: TypeProperty) => TypeProperty | readonly TypeProperty[],
	): FluentType<Record<PropertyKey, unknown>>;
	keyof(): FluentType<Extract<keyof t, PropertyKey>, Extract<keyof InputObject<i>, PropertyKey>>;
	get<key extends keyof t>(
		key: key,
	): FluentType<t[key], key extends keyof InputObject<i> ? InputObject<i>[key] : unknown>;
	pick<const keys extends readonly (keyof t)[]>(
		...keys: keys
	): FluentType<Pick<t, keys[number]>, Pick<InputObject<i>, Extract<keys[number], keyof InputObject<i>>>>;
	omit<const keys extends readonly (keyof t)[]>(
		...keys: keys
	): FluentType<Omit<t, keys[number]>, Omit<InputObject<i>, Extract<keys[number], keyof InputObject<i>>>>;
	partial(): FluentType<Partial<t>, Partial<InputObject<i>>>;
	required(): FluentType<Required<t>, Required<InputObject<i>>>;
	merge<r, ri>(def: SchemaInference<r, ri>): FluentType<MergeTypes<t, r>, MergeTypes<i, ri>>;
	merge<const def extends Record<string, unknown>>(
		def: def,
	): FluentType<MergeTypes<t, InferObjectLiteral<def>>, MergeTypes<i, InferObjectLiteral<def>>>;
	merge(def: Def): FluentType<unknown>;
}

type ObjectMethodsFor<t, i> = [t] extends [never]
	? unknown
	: [t] extends [readonly unknown[]]
		? unknown
		: [t] extends [object]
			? ObjectMethods<t & object, i>
			: unknown;
/** Callable schema with fluent methods specialized to its output and input. */
export type FluentType<t = unknown, i = t> = Type<t, i> & FluentMethods<t, i> & ObjectMethodsFor<t, i>;

/** Runtime constructor-like value used by ArkType-compatible `instanceof Type` checks. */
export const Type = Object.defineProperty(function Type(): void {}, Symbol.hasInstance, {
	value: (value: unknown): boolean =>
		(typeof value === "function" || (typeof value === "object" && value !== null)) && IR_BRAND in value,
});

interface Step {
	kind: "pipe" | "narrow" | "filter";
	fn: (data: unknown, ctx: NarrowContext) => unknown;
}

interface TypeMeta {
	description?: string;
	defaultValue?: unknown;
	hasDefault?: boolean;
	errorConfig?: ErrorConfig;
}

class Ctx implements NarrowContext {
	expectation: string | undefined;

	mustBe(expectation: string): false {
		this.expectation = expectation;
		return false;
	}

	reject(problem: string): false {
		this.expectation = problem;
		return false;
	}
}

type Validator = (data: unknown) => unknown;

const kBase = Symbol("omptype.base");
const kSteps = Symbol("omptype.steps");

const EMPTY_STEPS: Step[] = [];
const EMPTY_META: TypeMeta = {};

interface InternalType {
	(data: unknown): unknown;
	[IR_BRAND]: true;
	[kBase]: Validator;
	[kSteps]: Step[];
	ir: IR;
	hasSteps: boolean;
	hasDefault: boolean;
	defaultValue?: unknown;
	description?: string;
	errorConfig?: ErrorConfig;
	run: Validator;
}

/** Calls before the JIT compiles a schema (first two run the interpreter). */
const JIT_THRESHOLD = 3;

function metaOf(schema: InternalType): TypeMeta {
	return {
		description: schema.description,
		defaultValue: schema.defaultValue,
		hasDefault: schema.hasDefault,
		errorConfig: schema.errorConfig,
	};
}

const typeMethods = {
	describe(this: InternalType, description: string): InternalType {
		return makeType({ ...this.ir, desc: description }, this[kSteps], { ...metaOf(this), description });
	},

	configure(this: InternalType, config: SchemaConfig): InternalType {
		const errorConfig: ErrorConfig = {
			...this.errorConfig,
			...(config.expected === undefined ? {} : { expected: config.expected }),
			...(config.actual === undefined ? {} : { actual: config.actual }),
			...(config.problem === undefined ? {} : { problem: config.problem }),
			...(config.message === undefined ? {} : { message: config.message }),
		};
		const meta = {
			...metaOf(this),
			errorConfig,
			...(config.description === undefined ? {} : { description: config.description }),
		};
		return config.description === undefined
			? makeType(this.ir, this[kSteps], meta)
			: makeType({ ...this.ir, desc: config.description }, this[kSteps], meta);
	},

	default(this: InternalType, value: unknown): InternalType {
		return makeType(this.ir, this[kSteps], { ...metaOf(this), defaultValue: value, hasDefault: true });
	},

	optional(this: InternalType): readonly [InternalType, "?"] {
		return [this, "?"];
	},

	or(this: InternalType, def: Def): InternalType {
		const other = parseDef(def);
		const a = embed(this);
		const members = [...(a.k === "union" ? a.members : [a]), ...(other.k === "union" ? other.members : [other])];
		return makeType({ k: "union", members }, [], {});
	},

	equals(this: InternalType, def: Def): boolean {
		return irEquals(embed(this), parseDef(def));
	},

	ifEquals(this: InternalType, def: Def): InternalType | undefined {
		return irEquals(embed(this), parseDef(def)) ? this : undefined;
	},

	extends(this: InternalType, def: Def): boolean {
		return isSubtype(embed(this), parseDef(def));
	},

	overlaps(this: InternalType, def: Def): boolean {
		try {
			intersect(embed(this), parseDef(def));
			return true;
		} catch (error) {
			if (error instanceof OmpTypeError) return false;
			throw error;
		}
	},

	distribute(this: InternalType, mapper: (branch: BaseType) => InternalType): InternalType {
		const branches = this.ir.k === "union" ? this.ir.members : [embed(this)];
		const members = branches.map(branch => embed(mapper(makeType(branch, [], {}) as unknown as BaseType)));
		return makeType(members.length === 1 ? members[0] : { k: "union", members }, [], {});
	},

	select(this: InternalType, kind: string): readonly SelectedNode[] {
		return selectNodes(this.ir, kind);
	},

	and(this: InternalType, def: Def): InternalType {
		return makeType(intersect(embed(this), parseDef(def)), [], {});
	},

	array(this: InternalType): InternalType {
		return makeType({ k: "array", el: embed(this) }, [], {});
	},

	atLeastLength(this: InternalType, bound: number): InternalType {
		return makeType(withLengthBound(this.ir, "min", bound), this[kSteps], metaOf(this));
	},

	atMostLength(this: InternalType, bound: number): InternalType {
		return makeType(withLengthBound(this.ir, "max", bound), this[kSteps], metaOf(this));
	},

	moreThanLength(this: InternalType, bound: number): InternalType {
		return makeType(withLengthBound(this.ir, "min", bound + 1), this[kSteps], metaOf(this));
	},

	lessThanLength(this: InternalType, bound: number): InternalType {
		return makeType(withLengthBound(this.ir, "max", bound - 1), this[kSteps], metaOf(this));
	},

	exactlyLength(this: InternalType, bound: number): InternalType {
		const bounded = withLengthBound(withLengthBound(this.ir, "min", bound), "max", bound);
		return makeType(bounded, this[kSteps], metaOf(this));
	},

	atLeast(this: InternalType, bound: number): InternalType {
		return makeType(withNumericBound(this.ir, "min", bound), this[kSteps], metaOf(this));
	},

	atMost(this: InternalType, bound: number): InternalType {
		return makeType(withNumericBound(this.ir, "max", bound), this[kSteps], metaOf(this));
	},

	moreThan(this: InternalType, bound: number): InternalType {
		return makeType(withNumericBound(this.ir, "min", bound, true), this[kSteps], metaOf(this));
	},

	lessThan(this: InternalType, bound: number): InternalType {
		return makeType(withNumericBound(this.ir, "max", bound, true), this[kSteps], metaOf(this));
	},

	divisibleBy(this: InternalType, divisor: number): InternalType {
		if (this.ir.k !== "number") throw new OmpTypeError(`cannot apply divisibility to ${this.ir.k}`);
		if (!Number.isFinite(divisor) || divisor === 0) throw new OmpTypeError("divisor must be non-zero");
		return makeType({ ...this.ir, divisor }, this[kSteps], metaOf(this));
	},

	positive(this: InternalType): InternalType {
		return makeType(withNumericBound(this.ir, "min", 0, true), this[kSteps], metaOf(this));
	},

	negative(this: InternalType): InternalType {
		return makeType(withNumericBound(this.ir, "max", 0, true), this[kSteps], metaOf(this));
	},

	nonNegative(this: InternalType): InternalType {
		return makeType(withNumericBound(this.ir, "min", 0), this[kSteps], metaOf(this));
	},

	nonPositive(this: InternalType): InternalType {
		return makeType(withNumericBound(this.ir, "max", 0), this[kSteps], metaOf(this));
	},

	matching(this: InternalType, pattern: RegExp): InternalType {
		return makeType(intersect(this.ir, patternIR(pattern)), this[kSteps], metaOf(this));
	},

	atOrAfter(this: InternalType, bound: Date): InternalType {
		return dateRefinement(this, bound, "at or after", value => value >= bound.valueOf());
	},

	atOrBefore(this: InternalType, bound: Date): InternalType {
		return dateRefinement(this, bound, "at or before", value => value <= bound.valueOf());
	},

	laterThan(this: InternalType, bound: Date): InternalType {
		return dateRefinement(this, bound, "later than", value => value > bound.valueOf());
	},

	earlierThan(this: InternalType, bound: Date): InternalType {
		return dateRefinement(this, bound, "earlier than", value => value < bound.valueOf());
	},

	pipe(this: InternalType, fn: Step["fn"]): InternalType {
		return makeType(this.ir, [...this[kSteps], { kind: "pipe", fn }], metaOf(this));
	},

	to(this: InternalType, def: unknown): InternalType {
		const output = makeType(parseDef(def), [], {});
		return makeType(
			this.ir,
			[
				...this[kSteps],
				{
					kind: "pipe",
					fn: value => output(value),
				},
			],
			metaOf(this),
		);
	},

	filter(this: InternalType, fn: Step["fn"]): InternalType {
		return makeType(this.ir, [{ kind: "filter", fn }, ...this[kSteps]], metaOf(this));
	},

	narrow(this: InternalType, fn: Step["fn"]): InternalType {
		return makeType(this.ir, [...this[kSteps], { kind: "narrow", fn }], metaOf(this));
	},

	brand(this: InternalType): InternalType {
		return makeType(this.ir, this[kSteps], metaOf(this));
	},

	as(this: InternalType): InternalType {
		return makeType(this.ir, this[kSteps], metaOf(this));
	},

	keyof(this: InternalType): InternalType {
		return makeType(keyOf(this.ir), [], {});
	},

	get(this: InternalType, key: PropertyKey): InternalType {
		const object = requireObject(this.ir, "get");
		const prop = object.props.find(candidate => candidate.key === String(key));
		if (!prop) throw new OmpTypeError(`key ${String(key)} is not declared`);
		const ir: IR = prop.opt ? { k: "union", members: [prop.val, { k: "undefined" }] } : prop.val;
		return makeType(ir, [], {});
	},

	pick(this: InternalType, ...keys: PropertyKey[]): InternalType {
		const object = requireObject(this.ir, "pick");
		const selected = new Set(keys.map(String));
		return makeType({ ...object, props: object.props.filter(prop => selected.has(prop.key)) }, [], {});
	},

	omit(this: InternalType, ...keys: PropertyKey[]): InternalType {
		const object = requireObject(this.ir, "omit");
		const omitted = new Set(keys.map(String));
		return makeType({ ...object, props: object.props.filter(prop => !omitted.has(prop.key)) }, [], {});
	},

	partial(this: InternalType): InternalType {
		const object = requireObject(this.ir, "partial");
		return makeType({ ...object, props: object.props.map(prop => ({ ...prop, opt: true })) }, [], {});
	},

	required(this: InternalType): InternalType {
		const object = requireObject(this.ir, "required");
		return makeType({ ...object, props: object.props.map(prop => ({ ...prop, opt: false })) }, [], {});
	},

	map(this: InternalType, mapper: (property: TypeProperty) => TypeProperty | readonly TypeProperty[]): InternalType {
		const object = requireObject(this.ir, "map");
		const props = object.props.flatMap(prop => {
			const mapped = mapper(propertyFromIR(prop));
			return (Array.isArray(mapped) ? mapped : [mapped]).map(propertyToIR);
		});
		return makeType({ ...object, props }, [], {});
	},

	merge(this: InternalType, def: unknown): InternalType {
		return makeType(mergeObjects(requireObject(this.ir, "merge"), requireObject(parseDef(def), "merge")), [], {});
	},

	extract(this: InternalType, def: unknown): InternalType {
		const other = parseDef(def);
		return makeType(
			{
				k: "refine",
				base: embed(this),
				pred: value => !(walk(other, value) instanceof OmpErrors),
				expected: "a value included by the extracted type",
			},
			[],
			{},
		);
	},

	exclude(this: InternalType, def: unknown): InternalType {
		const other = parseDef(def);
		return makeType(
			{
				k: "refine",
				base: embed(this),
				pred: value => walk(other, value) instanceof OmpErrors,
				expected: "a value not excluded by the type",
			},
			[],
			{},
		);
	},

	onUndeclaredKey(this: InternalType, behavior: "ignore" | "reject" | "delete"): InternalType {
		const object = requireObject(this.ir, "onUndeclaredKey");
		return makeType({ ...object, extras: behavior === "ignore" ? "keep" : behavior }, this[kSteps], metaOf(this));
	},

	onDeepUndeclaredKey(this: InternalType, behavior: "ignore" | "reject" | "delete"): InternalType {
		return makeType(withDeepExtras(this.ir, behavior === "ignore" ? "keep" : behavior), this[kSteps], metaOf(this));
	},

	allows(this: InternalType, data: unknown): boolean {
		for (const step of this[kSteps]) {
			if (step.kind === "filter" && !step.fn(data, new Ctx())) return false;
		}
		const out = this[kBase](data);
		if (out instanceof OmpErrors) return false;
		for (const step of this[kSteps]) {
			if (step.kind === "narrow" && !step.fn(out, new Ctx())) return false;
		}
		return true;
	},

	assert(this: InternalType, data: unknown): unknown {
		const out = this.run(data);
		if (out instanceof OmpErrors) throw new TraversalError(out);
		return out;
	},

	from(this: InternalType, data: unknown): unknown {
		const out = this.run(data);
		if (out instanceof OmpErrors) throw new TraversalError(out);
		return out;
	},

	toJsonSchema(this: InternalType, options?: ToJsonSchemaOptions): Record<string, unknown> {
		const description = options?.description ?? this.description;
		return irToJsonSchema(
			this.ir,
			options === undefined && description === undefined
				? undefined
				: { ...options, ...(description === undefined ? {} : { description }) },
		);
	},
};

Object.defineProperty(typeMethods, "props", {
	get(this: InternalType): readonly TypeProperty[] {
		const object = requireObject(this.ir, "props");
		return object.props.map(prop => propertyFromIR(prop));
	},
});

// Share the fluent surface without per-schema method allocations or copies.
// Function.prototype remains in the chain, except bind is intentionally hidden
// so generic tool wrappers recognize callable schemas rather than rebinding them.
Object.setPrototypeOf(typeMethods, Function.prototype);
Object.defineProperty(typeMethods, "bind", { value: undefined });

function makeType(ir: IR, steps: Step[], meta: TypeMeta): InternalType;
function makeType<t = unknown, i = t>(ir: IR, steps: Step[], meta: TypeMeta): FluentType<t, i>;
function makeType(ir: IR, steps: Step[], meta: TypeMeta): unknown {
	let calls = 0;
	let impl: Validator = (data: unknown): unknown => {
		if (++calls >= JIT_THRESHOLD) {
			impl = compile(ir);
			return impl(data);
		}
		return walk(ir, data);
	};

	const base: Validator =
		meta.errorConfig === undefined
			? (data: unknown): unknown => impl(data)
			: (data: unknown): unknown => {
					const result = impl(data);
					return result instanceof OmpErrors ? result.configure(meta.errorConfig ?? {}) : result;
				};

	const callable: Validator =
		steps.length === 0
			? base
			: (data: unknown): unknown => {
					for (const step of steps) {
						if (step.kind !== "filter") continue;
						const ctx = new Ctx();
						if (!step.fn(data, ctx)) {
							return OmpErrors.single(
								[],
								ctx.expectation ?? "valid (input predicate failed)",
								data,
								meta.errorConfig,
							);
						}
					}
					let out = base(data);
					if (out instanceof OmpErrors) return out;
					for (const step of steps) {
						if (step.kind === "filter") continue;
						const ctx = new Ctx();
						if (step.kind === "narrow") {
							if (!step.fn(out, ctx)) {
								return OmpErrors.single(
									[],
									ctx.expectation ?? "valid (narrow predicate failed)",
									out,
									meta.errorConfig,
								);
							}
						} else {
							out = step.fn(out, ctx);
							if (out instanceof OmpErrors) {
								return meta.errorConfig === undefined ? out : out.configure(meta.errorConfig);
							}
						}
					}
					return out;
				};

	const self = callable as InternalType;
	self[IR_BRAND] = true;
	self[kBase] = base;
	self[kSteps] = steps;
	self.ir = ir;
	self.hasSteps = steps.length > 0;
	self.hasDefault = meta.hasDefault === true;
	self.defaultValue = meta.defaultValue;
	self.description = meta.description;
	self.errorConfig = meta.errorConfig;
	self.run = callable;
	Object.setPrototypeOf(self, typeMethods);
	return self;
}

type ObjectIR = Extract<IR, { k: "object" }>;

function requireObject(ir: IR, operation: string): ObjectIR {
	if (ir.k !== "object") throw new OmpTypeError(`${operation} requires an object schema`);
	return ir;
}

function propertyFromIR(prop: PropIR): TypeProperty {
	return {
		kind: prop.opt ? "optional" : "required",
		key: prop.key,
		value: makeType(prop.val, [], {}) as unknown as FluentType<unknown>,
		...(prop.hasDefault ? { default: prop.def } : {}),
		meta: {},
	};
}

function propertyToIR(property: TypeProperty): PropIR {
	if (property.kind !== "required" && property.kind !== "optional") {
		throw new OmpTypeError(`mapped property ${String(property.key)} has invalid kind`);
	}
	if (!(IR_BRAND in property.value)) {
		throw new OmpTypeError(`mapped property ${String(property.key)} must contain a schema value`);
	}
	const hasDefault = Object.hasOwn(property, "default");
	return {
		key: String(property.key),
		opt: property.kind === "optional",
		val: embed(property.value),
		...(hasDefault
			? { def: property.default, defFactory: typeof property.default === "function", hasDefault: true }
			: {}),
	};
}

function dateRefinement(
	schema: InternalType,
	bound: Date,
	relation: string,
	predicate: (value: number) => boolean,
): InternalType {
	if (!Number.isFinite(bound.valueOf())) throw new OmpTypeError("date bound must be valid");
	return makeType(
		{
			k: "refine",
			base: schema.ir,
			pred: value => value instanceof Date && predicate(value.valueOf()),
			expected: `a Date ${relation} ${bound.toISOString()}`,
			json: relation.includes("after") ? { minimum: bound.toISOString() } : { maximum: bound.toISOString() },
		},
		schema[kSteps],
		metaOf(schema),
	);
}

function selectNodes(root: IR, kind: string): readonly SelectedNode[] {
	const selected: SelectedNode[] = [];
	const seen = new Set<IR>();
	const visit = (node: IR): void => {
		if (seen.has(node)) return;
		seen.add(node);
		const nodeKind = node.k === "lit" ? "unit" : node.k;
		if (kind === nodeKind || kind === node.k) {
			selected.push(node.k === "lit" ? { kind: nodeKind, node, unit: node.v } : { kind: nodeKind, node });
		}
		switch (node.k) {
			case "alias":
				visit(node.resolve());
				break;
			case "array":
				visit(node.el);
				break;
			case "tuple":
				for (const item of node.prefix) visit(item.val);
				if (node.variadic !== undefined) visit(node.variadic);
				for (const item of node.postfix) visit(item);
				break;
			case "object":
				for (const prop of node.props) visit(prop.val);
				if (node.index !== undefined) visit(node.index);
				break;
			case "union":
			case "intersection":
				for (const member of node.members) visit(member);
				break;
			case "refine":
				visit(node.base);
				break;
			case "morph":
				visit(node.input);
				if (node.out !== undefined) visit(node.out);
				break;
			case "sub":
				visit(node.schema.ir);
				break;
		}
	};
	visit(root);
	return selected;
}

function mergeObjects(left: ObjectIR, right: ObjectIR): ObjectIR {
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

function withDeepExtras(ir: IR, extras: ObjectIR["extras"]): IR {
	switch (ir.k) {
		case "object":
			return {
				...ir,
				extras,
				props: ir.props.map(prop => ({ ...prop, val: withDeepExtras(prop.val, extras) })),
				index: ir.index === undefined ? undefined : withDeepExtras(ir.index, extras),
			};
		case "array":
			return { ...ir, el: withDeepExtras(ir.el, extras) };
		case "tuple":
			return {
				...ir,
				prefix: ir.prefix.map(item => ({ ...item, val: withDeepExtras(item.val, extras) })),
				variadic: ir.variadic === undefined ? undefined : withDeepExtras(ir.variadic, extras),
				postfix: ir.postfix.map(item => withDeepExtras(item, extras)),
			};
		case "union":
		case "intersection":
			return { ...ir, members: ir.members.map(member => withDeepExtras(member, extras)) };
		case "refine":
			return { ...ir, base: withDeepExtras(ir.base, extras) };
		case "morph":
			return {
				...ir,
				input: withDeepExtras(ir.input, extras),
				out: ir.out === undefined ? undefined : withDeepExtras(ir.out, extras),
			};
		default:
			return ir;
	}
}

/** Intersect two IR nodes, rejecting statically disjoint domains. */
function intersect(a: IR, b: IR): IR {
	if (a.k === "alias") return intersect(a.resolve(), b);
	if (b.k === "alias") return intersect(a, b.resolve());
	if (a.k === "never" || b.k === "never") throw new OmpTypeError("intersection with never is unsatisfiable");
	if (a.k === "unknown") return b;
	if (b.k === "unknown") return a;
	if (a === b) return a;
	if (a.k === "union" || b.k === "union") {
		const union = a.k === "union" ? a : b.k === "union" ? b : undefined;
		if (union === undefined) throw new OmpTypeError("union intersection invariant failed");
		const branches = union.members;
		const other = a.k === "union" ? b : a;
		const members: IR[] = [];
		for (const branch of branches) {
			try {
				members.push(intersect(branch, other));
			} catch (error) {
				if (!(error instanceof OmpTypeError)) throw error;
			}
		}
		if (members.length === 0) throw new OmpTypeError("intersection has no satisfiable branches");
		return members.length === 1 ? members[0] : { k: "union", members };
	}
	if (a.k === "lit") {
		if (walk(b, a.v) instanceof OmpErrors) throw new OmpTypeError("literal is excluded by the intersection");
		return a;
	}
	if (b.k === "lit") return intersect(b, a);
	if (a.k === "object" && b.k === "object") {
		const props = [...a.props];
		for (const bp of b.props) {
			const index = props.findIndex(prop => prop.key === bp.key);
			if (index < 0) props.push(bp);
			else {
				const ap = props[index];
				props[index] = { ...ap, opt: ap.opt && bp.opt, val: intersect(ap.val, bp.val) };
			}
		}
		const extras =
			a.extras === "reject" || b.extras === "reject"
				? "reject"
				: a.extras === "delete" || b.extras === "delete"
					? "delete"
					: "keep";
		const index = a.index && b.index ? intersect(a.index, b.index) : (a.index ?? b.index);
		return { k: "object", props, index, extras };
	}
	if (a.k === "string" && b.k === "string") {
		const min = maxOf(a.min, b.min);
		const max = minOf(a.max, b.max);
		if (min !== undefined && max !== undefined && min > max) {
			throw new OmpTypeError("string length intersection is unsatisfiable");
		}
		return { k: "string", min, max, url: a.url || b.url };
	}
	if (a.k === "number" && b.k === "number") {
		const min = maxOf(a.min, b.min);
		const max = minOf(a.max, b.max);
		const xmin = min !== undefined && ((a.min === min && a.xmin === true) || (b.min === min && b.xmin === true));
		const xmax = max !== undefined && ((a.max === max && a.xmax === true) || (b.max === max && b.xmax === true));
		if (min !== undefined && max !== undefined && (min > max || (min === max && (xmin || xmax)))) {
			throw new OmpTypeError("numeric range intersection is unsatisfiable");
		}
		if (a.divisor !== undefined && b.divisor !== undefined && a.divisor !== b.divisor) {
			return { k: "intersection", members: [a, b] };
		}
		return {
			k: "number",
			int: a.int || b.int,
			divisor: a.divisor ?? b.divisor,
			min,
			max,
			xmin,
			xmax,
		};
	}
	if (a.k === "array" && b.k === "array") {
		const min = maxOf(a.min, b.min);
		const max = minOf(a.max, b.max);
		if (min !== undefined && max !== undefined && min > max) {
			throw new OmpTypeError("array length intersection is unsatisfiable");
		}
		return { k: "array", el: intersect(a.el, b.el), min, max };
	}
	if (a.k === "instance" && b.k === "instance") {
		if (a.ctor === b.ctor || a.ctor.prototype instanceof b.ctor) return a;
		if (b.ctor.prototype instanceof a.ctor) return b;
		throw new OmpTypeError(`intersection of ${a.expected} and ${b.expected} is unsatisfiable`);
	}
	if (a.k === b.k && ["null", "undefined", "boolean", "bigint", "symbol", "anyobject"].includes(a.k)) return a;
	const leftDomain = domainOf(a);
	const rightDomain = domainOf(b);
	if (leftDomain !== undefined && rightDomain !== undefined && leftDomain !== rightDomain) {
		throw new OmpTypeError(`intersection of ${leftDomain} and ${rightDomain} is unsatisfiable`);
	}
	if (a.k === "anyobject" && rightDomain === "object") return b;
	if (b.k === "anyobject" && leftDomain === "object") return a;
	const members = [...(a.k === "intersection" ? a.members : [a]), ...(b.k === "intersection" ? b.members : [b])];
	return { k: "intersection", members };
}

function domainOf(ir: IR): string | undefined {
	switch (ir.k) {
		case "null":
			return "null";
		case "undefined":
		case "boolean":
		case "bigint":
		case "symbol":
		case "string":
		case "number":
			return ir.k;
		case "array":
		case "tuple":
			return "array";
		case "object":
		case "anyobject":
		case "instance":
			return "object";
		case "lit":
			return ir.v === null ? "null" : Array.isArray(ir.v) ? "array" : typeof ir.v;
		case "refine":
			return domainOf(ir.base);
		case "morph":
			return domainOf(ir.input);
		case "sub":
			return domainOf(ir.schema.ir);
		case "alias":
			return domainOf(ir.resolve());
		case "union":
		case "intersection": {
			const first = domainOf(ir.members[0] ?? { k: "never" });
			return ir.members.every(member => domainOf(member) === first) ? first : undefined;
		}
		default:
			return undefined;
	}
}
function lowerBoundWithin(source: Extract<IR, { k: "number" }>, target: Extract<IR, { k: "number" }>): boolean {
	if (target.min === undefined) return true;
	if (source.min === undefined || source.min < target.min) return false;
	return source.min !== target.min || target.xmin !== true || source.xmin === true;
}

function upperBoundWithin(source: Extract<IR, { k: "number" }>, target: Extract<IR, { k: "number" }>): boolean {
	if (target.max === undefined) return true;
	if (source.max === undefined || source.max > target.max) return false;
	return source.max !== target.max || target.xmax !== true || source.xmax === true;
}

function lengthWithin(
	source: Extract<IR, { k: "string" | "array" }>,
	target: Extract<IR, { k: "string" | "array" }>,
): boolean {
	return (
		(target.min === undefined || (source.min !== undefined && source.min >= target.min)) &&
		(target.max === undefined || (source.max !== undefined && source.max <= target.max))
	);
}

function isSubtype(source: IR, target: IR, seen = new WeakMap<IR, Set<IR>>()): boolean {
	if (source === target || target.k === "unknown" || source.k === "never") return true;
	let targets = seen.get(source);
	if (targets?.has(target)) return true;
	if (targets === undefined) {
		targets = new Set();
		seen.set(source, targets);
	}
	targets.add(target);
	if (source.k === "alias") return isSubtype(source.resolve(), target, seen);
	if (target.k === "alias") return isSubtype(source, target.resolve(), seen);
	if (source.k === "union") return source.members.every(member => isSubtype(member, target, seen));
	if (target.k === "union") return target.members.some(member => isSubtype(source, member, seen));
	if (target.k === "intersection") return target.members.every(member => isSubtype(source, member, seen));
	if (source.k === "intersection") return source.members.some(member => isSubtype(member, target, seen));
	if (source.k === "lit") return !(walk(target, source.v) instanceof OmpErrors);
	if (source.k === "refine") return isSubtype(source.base, target, seen);
	if (source.k === "morph") return isSubtype(source.out ?? source.input, target, seen);
	if (source.k === "sub") return isSubtype(source.schema.ir, target, seen);
	if (target.k === "refine" || target.k === "morph" || target.k === "sub") return false;
	if (source.k === "string" && target.k === "string") {
		return lengthWithin(source, target) && (!target.url || source.url === true);
	}
	if (source.k === "number" && target.k === "number") {
		return (
			lowerBoundWithin(source, target) &&
			upperBoundWithin(source, target) &&
			(!target.int || source.int === true) &&
			(target.divisor === undefined || (source.divisor !== undefined && source.divisor % target.divisor === 0))
		);
	}
	if (source.k === "array" && target.k === "array") {
		return lengthWithin(source, target) && isSubtype(source.el, target.el, seen);
	}
	if (source.k === "object" && target.k === "object") {
		for (const targetProp of target.props) {
			const sourceProp = source.props.find(prop => prop.key === targetProp.key);
			if (sourceProp === undefined) {
				if (!targetProp.opt) return false;
				continue;
			}
			if (!targetProp.opt && sourceProp.opt) return false;
			if (!isSubtype(sourceProp.val, targetProp.val, seen)) return false;
		}
		if (target.extras === "reject") {
			if (source.extras !== "reject") return false;
			if (
				target.index === undefined &&
				source.props.some(sourceProp => !target.props.some(targetProp => targetProp.key === sourceProp.key))
			) {
				return false;
			}
		}
		return true;
	}
	if (source.k === "instance" && target.k === "instance") {
		return source.ctor === target.ctor || source.ctor.prototype instanceof target.ctor;
	}
	if (source.k === "object" && target.k === "anyobject") return true;
	if (source.k === "instance" && target.k === "anyobject") return true;
	if (source.k === "tuple" && target.k === "array") {
		return (
			source.prefix.every(item => isSubtype(item.val, target.el, seen)) &&
			source.postfix.every(item => isSubtype(item, target.el, seen)) &&
			(source.variadic === undefined || isSubtype(source.variadic, target.el, seen))
		);
	}
	if (source.k !== target.k) return false;
	switch (source.k) {
		case "null":
		case "undefined":
		case "boolean":
		case "bigint":
		case "symbol":
		case "anyobject":
			return true;
		case "tuple":
			return target.k === "tuple" && expectedTuple(source) === expectedTuple(target);
		case "instance":
			return target.k === "instance" && source.ctor === target.ctor;
		default:
			return false;
	}
}

function expectedTuple(tuple: Extract<IR, { k: "tuple" }>): string {
	return JSON.stringify({
		prefix: tuple.prefix.map(item => [item.opt, item.hasDefault, expectedOf(item.val)]),
		variadic: tuple.variadic === undefined ? undefined : expectedOf(tuple.variadic),
		postfix: tuple.postfix.map(expectedOf),
	});
}

function irEquals(left: IR, right: IR): boolean {
	return isSubtype(left, right) && isSubtype(right, left);
}

function maxOf(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.max(a, b);
}

function minOf(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return Math.min(a, b);
}

function withLengthBound(ir: IR, side: "min" | "max", bound: number): IR {
	if (ir.k === "array" || ir.k === "string") {
		return side === "min" ? { ...ir, min: bound } : { ...ir, max: bound };
	}
	throw new OmpTypeError(`cannot apply length bound to ${ir.k}`);
}
function withNumericBound(ir: IR, side: "min" | "max", bound: number, exclusive = false): IR {
	if (ir.k === "number") {
		return side === "min" ? { ...ir, min: bound, xmin: exclusive } : { ...ir, max: bound, xmax: exclusive };
	}
	throw new OmpTypeError(`cannot apply numeric bound to ${ir.k}`);
}

/**
 * Parse a definition into a callable schema with distinct input/output inference.
 */
export function type<const def>(def: def): FluentType<InferDef<def>, InferDefIn<def>> {
	return makeType<InferDef<def>, InferDefIn<def>>(parseDef(def), EMPTY_STEPS, EMPTY_META);
}

/** String keyword with a parser that morphs validated text to another output. */
export interface ParsedStringKeyword<parsed> extends FluentType<string> {
	readonly parse: FluentType<parsed, string>;
}

/** Morphing string keyword paired with its non-morphing preformatted validator. */
export interface PreformattedKeyword extends FluentType<string, string> {
	readonly preformatted: FluentType<string>;
}

/** Base64 keyword with its URL-safe alphabet variant. */
export interface Base64Keyword extends FluentType<string> {
	readonly url: FluentType<string>;
}

/** Date-string keyword family. */
export interface DateStringKeyword extends ParsedStringKeyword<Date> {
	readonly iso: ParsedStringKeyword<Date>;
	readonly epoch: ParsedStringKeyword<Date>;
}

/** IP address keyword family. */
export interface IpKeyword extends FluentType<string> {
	readonly v4: FluentType<string>;
	readonly v6: FluentType<string>;
}

/** UUID keyword family. */
export interface UuidKeyword extends FluentType<string> {
	readonly v1: FluentType<string>;
	readonly v2: FluentType<string>;
	readonly v3: FluentType<string>;
	readonly v4: FluentType<string>;
	readonly v5: FluentType<string>;
	readonly v6: FluentType<string>;
	readonly v7: FluentType<string>;
	readonly v8: FluentType<string>;
}

/** String normalization keyword family. */
export interface NormalizeKeyword extends PreformattedKeyword {
	readonly NFC: PreformattedKeyword;
	readonly NFD: PreformattedKeyword;
	readonly NFKC: PreformattedKeyword;
	readonly NFKD: PreformattedKeyword;
}

/** Runtime string parsers exposed under `type.parse`. */
export interface ParseKeyword {
	readonly number: FluentType<number, string>;
	readonly integer: FluentType<number, string>;
	readonly json: FluentType<unknown, string>;
	readonly date: FluentType<Date, string>;
	readonly url: FluentType<URL, string>;
	readonly boolean: FluentType<boolean, string>;
	readonly bigint: FluentType<bigint, string>;
}

/** Full string keyword module attached to `type.string`. */
export interface StringKeyword extends FluentType<string> {
	readonly alpha: FluentType<string>;
	readonly alphanumeric: FluentType<string>;
	readonly base64: Base64Keyword;
	readonly capitalize: PreformattedKeyword;
	readonly creditCard: FluentType<string>;
	readonly date: DateStringKeyword;
	readonly digits: FluentType<string>;
	readonly email: FluentType<string>;
	readonly hex: FluentType<string>;
	readonly integer: ParsedStringKeyword<number>;
	readonly ip: IpKeyword;
	readonly json: ParsedStringKeyword<unknown>;
	readonly lower: PreformattedKeyword;
	readonly normalize: NormalizeKeyword;
	readonly numeric: ParsedStringKeyword<number>;
	readonly regex: FluentType<string>;
	readonly semver: FluentType<string>;
	readonly trim: PreformattedKeyword;
	readonly upper: PreformattedKeyword;
	readonly url: ParsedStringKeyword<URL>;
	readonly uuid: UuidKeyword;
}

/** Number keyword module attached to `type.number`. */
export interface NumberKeyword extends FluentType<number> {
	readonly integer: FluentType<number>;
}

type Constructed<ctor> = ctor extends abstract new (...args: never[]) => infer instance ? instance : never;

function keywordSchema<output = string, input = output>(name: string): FluentType<output, input> {
	const ir = keywordIR(name);
	if (ir === undefined) throw new OmpTypeError(`missing built-in keyword ${name}`);
	return makeType<output, input>(ir, [], {});
}

function parsedKeyword<parsed>(name: string): ParsedStringKeyword<parsed> {
	return Object.assign(keywordSchema<string>(name), {
		parse: keywordSchema<parsed, string>(`${name}.parse`),
	});
}

function preformattedKeyword(name: string): PreformattedKeyword {
	return Object.assign(keywordSchema<string, string>(name), {
		preformatted: keywordSchema(`${name}.preformatted`),
	});
}

function caseResolver(value: unknown): (input: unknown) => unknown {
	if (typeof value !== "function") throw new OmpTypeError("match case values must be functions");
	return input => Reflect.apply(value, undefined, [input]);
}

export namespace type {
	/** Error aggregate returned by failed validations (`result instanceof type.errors`). */
	export const errors = OmpErrors;
	export type errors = OmpErrors;

	const normalize: NormalizeKeyword = Object.assign(keywordSchema<string, string>("string.normalize"), {
		preformatted: keywordSchema("string.normalize.NFC.preformatted"),
		NFC: preformattedKeyword("string.normalize.NFC"),
		NFD: preformattedKeyword("string.normalize.NFD"),
		NFKC: preformattedKeyword("string.normalize.NFKC"),
		NFKD: preformattedKeyword("string.normalize.NFKD"),
	});
	const base64: Base64Keyword = Object.assign(keywordSchema("string.base64"), {
		url: keywordSchema("string.base64.url"),
	});
	const date: DateStringKeyword = Object.assign(parsedKeyword<Date>("string.date"), {
		iso: parsedKeyword<Date>("string.date.iso"),
		epoch: parsedKeyword<Date>("string.date.epoch"),
	});
	const ip: IpKeyword = Object.assign(keywordSchema("string.ip"), {
		v4: keywordSchema("string.ip.v4"),
		v6: keywordSchema("string.ip.v6"),
	});
	const uuid: UuidKeyword = Object.assign(keywordSchema("string.uuid"), {
		v1: keywordSchema("string.uuid.v1"),
		v2: keywordSchema("string.uuid.v2"),
		v3: keywordSchema("string.uuid.v3"),
		v4: keywordSchema("string.uuid.v4"),
		v5: keywordSchema("string.uuid.v5"),
		v6: keywordSchema("string.uuid.v6"),
		v7: keywordSchema("string.uuid.v7"),
		v8: keywordSchema("string.uuid.v8"),
	});

	/** String validator and its refinement/morph keyword module. */
	export const string: StringKeyword = Object.assign(makeType<string>({ k: "string" }, [], {}), {
		alpha: keywordSchema("string.alpha"),
		alphanumeric: keywordSchema("string.alphanumeric"),
		base64,
		capitalize: preformattedKeyword("string.capitalize"),
		creditCard: keywordSchema("string.creditCard"),
		date,
		digits: keywordSchema("string.digits"),
		email: keywordSchema("string.email"),
		hex: keywordSchema("string.hex"),
		integer: parsedKeyword<number>("string.integer"),
		ip,
		json: parsedKeyword<unknown>("string.json"),
		lower: preformattedKeyword("string.lower"),
		normalize,
		numeric: parsedKeyword<number>("string.numeric"),
		regex: keywordSchema("string.regex"),
		semver: keywordSchema("string.semver"),
		trim: preformattedKeyword("string.trim"),
		upper: preformattedKeyword("string.upper"),
		url: parsedKeyword<URL>("string.url"),
		uuid,
	});

	/** Runtime parser keyword family. */
	export const parse: ParseKeyword = {
		number: keywordSchema<number, string>("parse.number"),
		integer: keywordSchema<number, string>("parse.integer"),
		json: keywordSchema<unknown, string>("parse.json"),
		date: keywordSchema<Date, string>("parse.date"),
		url: keywordSchema<URL, string>("parse.url"),
		boolean: keywordSchema<boolean, string>("parse.boolean"),
		bigint: keywordSchema<bigint, string>("parse.bigint"),
	};

	/** Number validator with integer refinement. */
	export const number: NumberKeyword = Object.assign(makeType<number>({ k: "number" }, [], {}), {
		integer: makeType<number>({ k: "number", int: true }, [], {}),
	});

	/** Boolean validator. */
	export const boolean = makeType<boolean>({ k: "boolean" }, [], {});
	/** Bigint validator. */
	export const bigint = makeType<bigint>({ k: "bigint" }, [], {});
	/** Symbol validator. */
	export const symbol = makeType<symbol>({ k: "symbol" }, [], {});
	/** Non-null object validator. */
	export const object = makeType<object>({ k: "anyobject" }, [], {});
	/** Unknown validator. */
	export const unknown = makeType<unknown>({ k: "unknown" }, [], {});
	/** Alias of the unknown validator. */
	export const any = unknown;
	/** Validator that rejects every value. */
	export const never = makeType<never>({ k: "never" }, [], {});
	/** Date instance validator. */
	// biome-ignore lint/suspicious/noShadowRestrictedNames: ArkType exposes this exact keyword.
	export const Date = makeType<globalThis.Date>({ k: "instance", ctor: globalThis.Date, expected: "a Date" }, [], {});

	/** Validate instances of `ctor`. */
	export function instanceOf<const ctor extends Constructor>(ctor: ctor): FluentType<Constructed<ctor>> {
		const name = Reflect.get(ctor, "name");
		const expected = typeof name === "string" && name.length > 0 ? `an instance of ${name}` : "an instance";
		return makeType<Constructed<ctor>>({ k: "instance", ctor, expected }, [], {});
	}

	/** Validate one exact unit value. */
	export function unit<const value>(value: value): FluentType<value> {
		return makeType<value>({ k: "lit", v: value }, [], {});
	}

	/** Union of literal values from a runtime array. */
	export function enumerated<const values extends readonly unknown[]>(...values: values): FluentType<values[number]> {
		const members: IR[] = values.map(value => ({ k: "lit", v: value }));
		const ir: IR =
			members.length === 0 ? { k: "never" } : members.length === 1 ? members[0] : { k: "union", members };
		return makeType<values[number]>(ir, [], {});
	}

	/** Build a first-match dispatcher from schema-expression keys and a `default` case. */
	export function match<const cases extends Record<string, unknown>>(cases: cases): (value: unknown) => unknown {
		const branches: { schema: BaseType; resolve: (value: unknown) => unknown }[] = [];
		let fallback: ((value: unknown) => unknown) | undefined;
		for (const definition in cases) {
			const resolver = caseResolver(cases[definition]);
			if (definition === "default") fallback = resolver;
			else branches.push({ schema: raw(definition), resolve: resolver });
		}
		return value => {
			for (const branch of branches) {
				if (branch.schema.allows(value)) return branch.resolve(value);
			}
			if (fallback !== undefined) return fallback(value);
			throw new OmpTypeError("match requires a matching case or default");
		};
	}
	/** Preserve a definition's literal type while authoring reusable modules. */
	export function define<const definition>(definition: definition): definition {
		return definition;
	}

	/** Build a lazy named scope from aliases and recursive definitions. */
	export function scope(aliases: Record<string, unknown>, options?: ScopeOptions): TypeScope {
		return buildScope(aliases, options);
	}

	/** Compile a named schema module whose definitions may reference each other. */
	export function module<const definitions extends Record<string, unknown>>(
		definitions: definitions,
	): { [name in keyof definitions]: Type<InferDef<definitions[name]>, InferDefIn<definitions[name]>> } {
		return scope(definitions).export() as unknown as {
			[name in keyof definitions]: Type<InferDef<definitions[name]>, InferDefIn<definitions[name]>>;
		};
	}

	/** Build a runtime generic whose parameter names are supplied as `"<t, u>"`. */
	export function generic<const definition>(
		parameters: string,
		definition: definition,
	): (...arguments_: readonly unknown[]) => BaseType {
		const names = parameters
			.replace(/^<|>$/g, "")
			.split(",")
			.map(name => name.trim())
			.filter(Boolean);
		return (...arguments_) => {
			if (arguments_.length !== names.length) {
				throw new OmpTypeError(`generic expects ${names.length} arguments (received ${arguments_.length})`);
			}
			const aliases: Record<string, unknown> = {};
			for (let index = 0; index < names.length; index++) aliases[names[index]] = arguments_[index];
			return scope(aliases).type(definition) as BaseType;
		};
	}

	/** Untyped builder for runtime-assembled definitions. */
	export function raw(def: unknown): BaseType {
		return makeType(parseDef(def), [], {}) as unknown as BaseType;
	}
}

// Reserved words cannot be declared as namespace bindings, but ArkType exposes
// them as runtime keyword properties.
Object.assign(type, {
	null: makeType<null>({ k: "null" }, [], {}),
	undefined: makeType<undefined>({ k: "undefined" }, [], {}),
	true: makeType<true>({ k: "lit", v: true }, [], {}),
	false: makeType<false>({ k: "lit", v: false }, [], {}),
});

export interface ScopeOptions {
	jitless?: boolean;
}

/** Callable builder bound to one alias scope. */
export type ScopedBuilder = <const definition>(
	definition: definition,
) => FluentType<InferDef<definition>, InferDefIn<definition>>;

/** Named schema scope with a scoped builder and compiled module export. */
export interface TypeScope {
	readonly type: ScopedBuilder;
	export(): Record<string, BaseType>;
}

/** Build a scope whose aliases resolve lazily, including recursive cycles. */
export function scope(aliases: Record<string, unknown>, options?: ScopeOptions): TypeScope {
	return buildScope(aliases, options);
}

function buildScope(aliases: Record<string, unknown>, _options?: ScopeOptions): TypeScope {
	const references = new Map<string, IR>();
	const targets = new Map<string, IR>();
	const resolve: AliasResolver = name => {
		if (!Object.hasOwn(aliases, name)) return undefined;
		const existing = references.get(name);
		if (existing !== undefined) return existing;
		const reference: IR = {
			k: "alias",
			name,
			resolve: () => {
				const target = targets.get(name);
				if (target !== undefined) return target;
				const parsed = parseDef(aliases[name], resolve);
				targets.set(name, parsed);
				return parsed;
			},
		};
		references.set(name, reference);
		return reference;
	};
	const scoped = Object.assign(
		(definition: unknown) => makeType(parseDef(definition, resolve), [], {}),
		type,
	) as unknown as ScopedBuilder;
	return {
		type: scoped,
		export() {
			const schemas: Record<string, BaseType> = {};
			for (const name in aliases) schemas[name] = scoped(name) as unknown as BaseType;
			return schemas;
		},
	};
}

/** A schema whose output type is not statically known (`type.raw` results). */
export type BaseType = Type<unknown, unknown>;

/** `hasMorph` re-export for diagnostics/tooling. */
export { hasMorph };
