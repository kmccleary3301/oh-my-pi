/**
 * Validation error containers mirroring ArkType's observable error surface:
 * `result instanceof type.errors` / `instanceof OmpErrors`, lazy `.summary`,
 * array iteration, and per-entry `.path` / `.problem` / `.message`.
 *
 * Failure-path cost matters: schemas reject untrusted input constantly, so
 * construction stores only the path, the expectation, and the offending value.
 * All human-readable strings are built lazily on property access.
 */

/** Context supplied to configurable error formatters. */
export interface ErrorContext {
	readonly code: string;
	readonly path: readonly PropertyKey[];
	readonly data: unknown;
	readonly expected: string;
	readonly actual: string;
	readonly problem: string;
}

/** Per-schema overrides for validation error text. */
export interface ErrorConfig {
	readonly expected?: string | ((context: ErrorContext) => string);
	readonly actual?: string | ((context: ErrorContext) => string);
	readonly problem?: string | ((context: ErrorContext) => string);
	readonly message?: string | ((context: ErrorContext) => string);
}

function format(
	override: string | ((context: ErrorContext) => string) | undefined,
	context: ErrorContext,
	fallback: string,
): string {
	return typeof override === "function" ? override(context) : (override ?? fallback);
}

/** A single validation failure at one path. */
export class OmpError {
	#rawExpected: string;
	#config: ErrorConfig | undefined;

	constructor(
		/** Property path from the root to the failing value (empty at root). */
		readonly path: PropertyKey[],
		expected: string,
		/** The value that failed validation. */
		readonly data: unknown,
		config?: ErrorConfig,
	) {
		this.#rawExpected = expected;
		this.#config = config;
	}

	/** Stable category for programmatic error handling. */
	get code(): string {
		return errorCode(this.#rawExpected, this.data);
	}

	#context(expected: string, actual: string, problem = ""): ErrorContext {
		return { code: this.code, path: this.path, data: this.data, expected, actual, problem };
	}

	/** Human-readable expectation, including a configured override. */
	get expected(): string {
		const actual = describeValue(this.data);
		return format(this.#config?.expected, this.#context(this.#rawExpected, actual), this.#rawExpected);
	}

	/** Short description of the received value, e.g. `"a number"` or `"missing"`. */
	get actual(): string {
		const actual = describeValue(this.data);
		return format(this.#config?.actual, this.#context(this.expected, actual), actual);
	}

	/** Path-less problem statement: `must be <expected> (was <actual>)`. */
	get problem(): string {
		const expected = this.expected;
		const actual = this.actual;
		const fallback =
			this.data === MISSING ? `must be ${expected} (was missing)` : `must be ${expected} (was ${actual})`;
		return format(this.#config?.problem, this.#context(expected, actual, fallback), fallback);
	}

	/** Full message including the path prefix. */
	get message(): string {
		const expected = this.expected;
		const actual = this.actual;
		const problem = this.problem;
		const at = this.path.length === 0 ? "" : `${this.path.map(String).join(".")} `;
		return format(this.#config?.message, this.#context(expected, actual, problem), `${at}${problem}`);
	}

	toString(): string {
		return this.message;
	}
}

/** Sentinel for a required key that was absent (distinguishes from `undefined`). */
export const MISSING: unique symbol = Symbol("omptype.missing");

function describeValue(data: unknown): string {
	if (data === null) return "null";
	if (Array.isArray(data)) return "an array";
	switch (typeof data) {
		case "string":
			return data.length <= 40 ? JSON.stringify(data) : `a string (length ${data.length})`;
		case "number":
			return String(data);
		case "bigint":
			return `${data}n`;
		case "boolean":
			return String(data);
		case "undefined":
			return "undefined";
		case "object":
			return "an object";
		case "function":
			return "a function";
		default:
			return "a symbol";
	}
}

function errorCode(expected: string, data: unknown): string {
	if (data === MISSING) return "required";
	if (expected.includes("divisible by")) return "divisor";
	if (expected.includes("at least") || expected.includes("more than")) return "min";
	if (expected.includes("at most") || expected.includes("less than")) return "max";
	if (expected.includes("matching") || expected.includes("format") || expected.includes("email")) return "pattern";
	if (expected.includes("predicate") || expected.includes("satisfying")) return "predicate";
	if (expected.startsWith('"') || expected.startsWith("the date ")) return "unit";
	return "domain";
}

/**
 * Single-failure validation result with a lazy array-like entry.
 *
 * Validators fast-fail, so allocating an `Array` subclass and a separate entry
 * on every rejection only penalizes callers that inspect errors by identity.
 * Indexing, iteration, and `map` materialize the entry on demand.
 */
type StoredPath = PropertyKey[] | PropertyKey | undefined;

export class OmpErrors implements Iterable<OmpError> {
	#path: StoredPath;
	#expected: string;
	#data: unknown;
	#entry: OmpError | undefined;
	#config: ErrorConfig | undefined;

	/** Number of failures; omptype validators fast-fail on the first error. */
	readonly length = 1;

	constructor(path: StoredPath, expected: string, data: unknown, config?: ErrorConfig) {
		this.#path = path;
		this.#expected = expected;
		this.#data = data;
		this.#config = config;
	}

	/** First and only validation failure, materialized on demand. */
	get 0(): OmpError {
		return this.#getEntry();
	}

	static single(path: PropertyKey[], expected: string, data: unknown, config?: ErrorConfig): OmpErrors {
		return new OmpErrors(path, expected, data, config);
	}

	#getEntry(): OmpError {
		if (this.#entry) return this.#entry;
		const path = this.#path === undefined ? [] : Array.isArray(this.#path) ? this.#path : [this.#path];
		const entry = new OmpError(path, this.#expected, this.#data, this.#config);
		this.#entry = entry;
		return entry;
	}

	/** Prefix the failure path with `key` when nesting sub-schemas. */
	prefix(key: PropertyKey): this {
		const path = this.#path;
		this.#path = path === undefined ? [key] : Array.isArray(path) ? [key, ...path] : [key, path];
		this.#entry = undefined;
		return this;
	}

	/** Apply schema-local message formatting without rebuilding the failure. */
	configure(config: ErrorConfig): this {
		this.#config = { ...this.#config, ...config };
		this.#entry = undefined;
		return this;
	}

	/** Index the failure by its dotted property path (`""` for the root). */
	get byPath(): Readonly<Record<string, OmpError>> {
		const entry = this.#getEntry();
		return { [entry.path.map(String).join(".")]: entry };
	}

	/** Transform the failure entry into a plain array. */
	map<result>(fn: (error: OmpError, index: number, errors: OmpErrors) => result): result[] {
		return [fn(this.#getEntry(), 0, this)];
	}

	/** Select the failure entry into a plain array. */
	filter(fn: (error: OmpError, index: number, errors: OmpErrors) => unknown): OmpError[] {
		const entry = this.#getEntry();
		return fn(entry, 0, this) ? [entry] : [];
	}

	/** Iterate over the single failure entry. */
	*[Symbol.iterator](): IterableIterator<OmpError> {
		yield this.#getEntry();
	}

	/** Human-readable failure text, materialized only when requested. */
	get summary(): string {
		return this.#getEntry().message;
	}

	toString(): string {
		return this.summary;
	}

	/** Throw a `TraversalError` carrying this result. */
	throw(): never {
		throw new TraversalError(this);
	}
}

/** Error thrown by `Type.assert` on invalid input. */
export class TraversalError extends Error {
	constructor(readonly errors: OmpErrors) {
		super(errors.summary);
		this.name = "TraversalError";
	}
}

/**
 * Definition/usage error thrown while building a schema — malformed string
 * DSL, unsupported composition, or an illegal builder call. Distinct from
 * validation failures, which are returned as {@link OmpErrors}.
 */
export class OmpTypeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OmpTypeError";
	}
}
