/**
 * JIT compiler: lowers schema IR into a specialized validator via
 * `new Function`. Invoked by `type.ts` after a schema's third call; the
 * interpreter (`interp.ts`) covers earlier calls so rarely-used schemas never
 * pay codegen cost.
 *
 * Generated code philosophy:
 * - success path is straight-line monomorphic JS with zero allocation; when
 *   the schema has no morphs the input value itself is returned
 * - failure allocates a single `OmpErrors` (`E(path, expected, data)`); path
 *   arrays and messages are inline literals, so cost is one small allocation
 * - morphing nodes (defaults, `"+": "delete"`, embedded stepped schemas)
 *   produce a fresh output object; pure subtrees below them stay check-only
 * - morphing union members use separately compiled or hoisted runners; pure
 *   members compile to inline predicates
 */
import { MISSING, OmpErrors } from "./errors";
import { canRefineUnionFailure, unionFail, walk } from "./interp";
import { expectedOf, hasMorph, type IR, type MorphContext, type PropIR, type TupleIR } from "./ir";

const own = Object.prototype.hasOwnProperty;

const IDENT = /^[A-Za-z_$][\w$]*$/;

function access(base: string, key: string): string {
	return IDENT.test(key) ? `${base}.${key}` : `${base}[${JSON.stringify(key)}]`;
}

/** Inline-able literal, else undefined (caller hoists into the refs pool). */
function litSource(v: unknown): string | undefined {
	if (v === null) return "null";
	if (v === undefined) return "undefined";
	switch (typeof v) {
		case "string":
		case "boolean":
			return JSON.stringify(v);
		case "number":
			return Number.isFinite(v) ? String(v) : undefined;
		default:
			return undefined;
	}
}

type PathSeg = { s: PropertyKey } | { d: string };

class CompiledMorphContext implements MorphContext {
	#path: PropertyKey[] | PropertyKey | undefined;
	#data: unknown;

	constructor(path: PropertyKey[] | PropertyKey | undefined, data: unknown) {
		this.#path = path;
		this.#data = data;
	}

	error(expectation: string): OmpErrors {
		return new OmpErrors(this.#path, expectation, this.#data);
	}

	reject(expectation: string): OmpErrors {
		return this.error(expectation);
	}
}

class Builder {
	#lines: string[] = [];
	#refs: unknown[] = [];
	#activeAliases: Set<IR> | undefined;
	#id = 0;

	next(prefix: string): string {
		return `${prefix}${this.#id++}`;
	}

	push(line: string): void {
		this.#lines.push(line);
	}

	ref(value: unknown): string {
		const idx = this.#refs.indexOf(value);
		if (idx >= 0) return `R[${idx}]`;
		this.#refs.push(value);
		return `R[${this.#refs.length - 1}]`;
	}

	lit(v: unknown): string {
		return litSource(v) ?? this.ref(v);
	}

	pathExpr(segs: PathSeg[]): string {
		const parts = segs.map(seg => ("s" in seg ? JSON.stringify(seg.s) : seg.d));
		return `[${parts.join(",")}]`;
	}

	storedPathExpr(segs: PathSeg[]): string {
		if (segs.length === 0) return "undefined";
		if (segs.length === 1) {
			const seg = segs[0];
			return "s" in seg ? JSON.stringify(seg.s) : seg.d;
		}
		return this.pathExpr(segs);
	}

	fail(segs: PathSeg[], expected: string, dataExpr: string): string {
		return `return new AE(${this.storedPathExpr(segs)},${JSON.stringify(expected)},${dataExpr})`;
	}

	/** Pure boolean predicate for a morph-free subtree. */
	predicate(node: IR, v: string): string {
		switch (node.k) {
			case "unknown":
				return "true";
			case "null":
				return `${v}===null`;
			case "undefined":
				return `${v}===undefined`;
			case "boolean":
				return `typeof ${v}==="boolean"`;
			case "bigint":
				return `typeof ${v}==="bigint"`;
			case "symbol":
				return `typeof ${v}==="symbol"`;
			case "never":
				return "false";
			case "anyobject":
				return `(typeof ${v}==="object"&&${v}!==null)`;
			case "lit":
				return node.v instanceof Date
					? `(${v} instanceof Date&&${v}.valueOf()===${node.v.valueOf()})`
					: `${v}===${this.lit(node.v)}`;
			case "instance":
				return `${v} instanceof ${this.ref(node.ctor)}`;
			case "string": {
				let out = `typeof ${v}==="string"`;
				if (node.min !== undefined) out += `&&${v}.length>=${node.min}`;
				if (node.max !== undefined) out += `&&${v}.length<=${node.max}`;
				if (node.url) out += `&&URL.canParse(${v})`;
				return out;
			}
			case "number": {
				let out = node.int ? `Number.isInteger(${v})` : `Number.isFinite(${v})`;
				if (node.divisor !== undefined) out += `&&${v}%${node.divisor}===0`;
				if (node.min !== undefined) out += `&&${v}${node.xmin ? ">" : ">="}${node.min}`;
				if (node.max !== undefined) out += `&&${v}${node.xmax ? "<" : "<="}${node.max}`;
				return out;
			}
			case "union": {
				const lits = node.members.filter(
					(member): member is Extract<IR, { k: "lit" }> =>
						member.k === "lit" &&
						(member.v === null || (typeof member.v !== "object" && typeof member.v !== "function")),
				);
				if (lits.length > 8) {
					const values = this.ref(new Set(lits.map(member => member.v)));
					const literalNodes = new Set<IR>(lits);
					const rest = node.members.filter(member => !literalNodes.has(member));
					let out = `${values}.has(${v})`;
					for (const m of rest) out += `||(${this.predicate(m, v)})`;
					return `(${out})`;
				}
				return `(${node.members.map(m => `(${this.predicate(m, v)})`).join("||")})`;
			}
			case "intersection":
				return `(${node.members.map(member => `(${this.predicate(member, v)})`).join("&&")})`;
			case "array": {
				const x = this.next("x");
				let out = `Array.isArray(${v})`;
				if (node.min !== undefined) out += `&&${v}.length>=${node.min}`;
				if (node.max !== undefined) out += `&&${v}.length<=${node.max}`;
				out += `&&${v}.every(${x}=>${this.predicate(node.el, x)})`;
				return out;
			}
			case "object": {
				const checks = [`typeof ${v}==="object"`, `${v}!==null`, `!Array.isArray(${v})`];
				for (const p of node.props) {
					const av = access(v, p.key);
					const present = `${JSON.stringify(p.key)} in ${v}`;
					checks.push(
						p.opt || p.hasDefault
							? `(!(${present})||(${this.predicate(p.val, av)}))`
							: `((${present})&&(${this.predicate(p.val, av)}))`,
					);
				}
				if (node.index) {
					const k = this.next("k");
					checks.push(
						`(()=>{for(const ${k} in ${v})if(own.call(${v},${k})&&!(${this.predicate(node.index, `${v}[${k}]`)}))return false;return true})()`,
					);
				} else if (node.extras === "reject") {
					const k = this.next("k");
					checks.push(
						`(()=>{for(const ${k} in ${v})if(own.call(${v},${k})&&!(${this.declaredCheck(node.props, k)}))return false;return true})()`,
					);
				}
				return `(${checks.join("&&")})`;
			}
			case "sub":
				return `!(${this.ref(node.schema.run)}(${v}) instanceof AE)`;
			default:
				return `!(${this.ref(boundWalk(node))}(${v}) instanceof AE)`;
		}
	}

	declaredCheck(props: PropIR[], keyVar: string): string {
		if (props.length === 0) return "false";
		if (props.length > 6) {
			const set = this.ref(new Set(props.map(p => p.key)));
			return `${set}.has(${keyVar})`;
		}
		return `(${props.map(p => `${keyVar}===${JSON.stringify(p.key)}`).join("||")})`;
	}

	emitDelegate(node: IR, v: string, segs: PathSeg[], out?: string): void {
		const runner = node.k === "sub" ? node.schema.run : boundWalk(node);
		const result = this.next("r");
		this.push(`const ${result}=${this.ref(runner)}(${v});`);
		this.push(
			segs.length === 0
				? `if(${result} instanceof AE)return ${result};`
				: `if(${result} instanceof AE)return PF(${result},${this.pathExpr(segs)});`,
		);
		if (out !== undefined) this.push(`${out}=${result};`);
	}

	emitTupleShape(
		node: TupleIR,
		v: string,
		segs: PathSeg[],
		failureData: string,
	): { postfixStart: string; prefixCount: string; requiredPrefix: number } {
		this.push(`if(!Array.isArray(${v}))${this.fail(segs, "an array", failureData)};`);
		const requiredPrefix = node.prefix.filter(item => !item.opt && !item.hasDefault).length;
		const minimum = requiredPrefix + node.postfix.length;
		if (minimum > 0) {
			this.push(
				`if(${v}.length<${minimum})${this.fail(segs, `an array of at least length ${minimum}`, failureData)};`,
			);
		}
		if (node.variadic === undefined) {
			const maximum = node.prefix.length + node.postfix.length;
			this.push(
				`if(${v}.length>${maximum})${this.fail(segs, `an array of at most length ${maximum}`, failureData)};`,
			);
		}
		let postfixStart = `${v}.length`;
		if (node.postfix.length > 0) {
			postfixStart = this.next("p");
			this.push(`const ${postfixStart}=${v}.length-${node.postfix.length};`);
		}
		let prefixCount = String(node.prefix.length);
		if (requiredPrefix !== node.prefix.length) {
			prefixCount = this.next("n");
			this.push(`const ${prefixCount}=Math.min(${node.prefix.length},${postfixStart});`);
		}
		return { postfixStart, prefixCount, requiredPrefix };
	}

	/** Statement-form check for a morph-free subtree with precise error paths. */
	emitCheck(node: IR, v: string, segs: PathSeg[], failureData = v): void {
		switch (node.k) {
			case "unknown":
				return;
			case "array": {
				let head = `Array.isArray(${v})`;
				if (node.min !== undefined) head += `&&${v}.length>=${node.min}`;
				if (node.max !== undefined) head += `&&${v}.length<=${node.max}`;
				this.push(`if(!(${head}))${this.fail(segs, expectedOf(node), failureData)};`);
				const i = this.next("i");
				const x = this.next("x");
				this.push(`for(let ${i}=0;${i}<${v}.length;${i}++){const ${x}=${v}[${i}];`);
				this.emitCheck(node.el, x, [...segs, { d: i }]);
				this.push("}");
				return;
			}
			case "tuple": {
				const { postfixStart, prefixCount, requiredPrefix } = this.emitTupleShape(node, v, segs, failureData);
				for (let index = 0; index < node.prefix.length; index++) {
					if (index >= requiredPrefix) this.push(`if(${index}<${prefixCount}){`);
					this.emitCheck(node.prefix[index].val, `${v}[${index}]`, [...segs, { d: String(index) }]);
					if (index >= requiredPrefix) this.push("}");
				}
				if (node.variadic !== undefined) {
					const index = this.next("i");
					this.push(`for(let ${index}=${prefixCount};${index}<${postfixStart};${index}++){`);
					this.emitCheck(node.variadic, `${v}[${index}]`, [...segs, { d: index }]);
					this.push("}");
				}
				for (let index = 0; index < node.postfix.length; index++) {
					const inputIndex = index === 0 ? postfixStart : `${postfixStart}+${index}`;
					this.emitCheck(node.postfix[index], `${v}[${inputIndex}]`, [...segs, { d: inputIndex }]);
				}
				return;
			}
			case "object": {
				this.push(
					`if(typeof ${v}!=="object"||${v}===null||Array.isArray(${v}))${this.fail(segs, "an object", failureData)};`,
				);
				for (const p of node.props) {
					const present = `${JSON.stringify(p.key)} in ${v}`;
					const propSegs: PathSeg[] = [...segs, { s: p.key }];
					if (p.opt || p.hasDefault) {
						this.push(`if(${present}){`);
						this.emitCheck(p.val, access(v, p.key), propSegs);
						this.push("}");
					} else {
						this.push(`if(!(${present}))${this.fail(propSegs, expectedOf(p.val), "M")};`);
						this.emitCheck(p.val, access(v, p.key), propSegs);
					}
				}
				if (node.index) {
					const k = this.next("k");
					this.push(`for(const ${k} in ${v})if(own.call(${v},${k})){`);
					this.emitCheck(node.index, `${v}[${k}]`, [...segs, { d: k }]);
					this.push("}");
				} else if (node.extras === "reject") {
					const k = this.next("k");
					this.push(
						`for(const ${k} in ${v})if(own.call(${v},${k})&&!(${this.declaredCheck(node.props, k)}))${this.fail(
							[...segs, { d: k }],
							"removed (undeclared key)",
							`${v}[${k}]`,
						)};`,
					);
				}
				return;
			}
			case "sub":
				this.emitDelegate(node, v, segs);
				return;
			case "union": {
				const failure = node.members.some(canRefineUnionFailure)
					? `return UF(${this.ref(node)},${failureData},${this.pathExpr(segs)},${JSON.stringify(expectedOf(node))})`
					: this.fail(segs, expectedOf(node), failureData);
				this.push(`if(!(${this.predicate(node, v)}))${failure};`);
				return;
			}
			case "null":
			case "undefined":
			case "boolean":
			case "bigint":
			case "symbol":
			case "never":
			case "anyobject":
			case "lit":
			case "string":
			case "number":
			case "instance":
				this.push(`if(!(${this.predicate(node, v)}))${this.fail(segs, expectedOf(node), failureData)};`);
				return;
			case "refine": {
				this.emitCheck(node.base, v, segs, failureData);
				const failure = this.fail(segs, node.expected, v);
				this.push(`try{if(!${this.ref(node.pred)}(${v}))${failure};}catch{${failure};}`);
				return;
			}
			case "intersection":
				for (const member of node.members) this.emitCheck(member, v, segs, failureData);
				return;
			default:
				this.emitDelegate(node, v, segs);
		}
	}

	/**
	 * Validate `v` against a morphing subtree and assign the produced output
	 * to `out` (an already-declared `let`).
	 */
	emitProduce(node: IR, v: string, segs: PathSeg[], out: string, failureData = v): void {
		if (!hasMorph(node)) {
			this.emitCheck(node, v, segs, failureData);
			this.push(`${out}=${v};`);
			return;
		}
		switch (node.k) {
			case "sub":
				this.emitDelegate(node, v, segs, out);
				return;
			case "morph": {
				const input = this.next("t");
				this.push(`let ${input};`);
				this.emitProduce(node.input, v, segs, input, failureData);
				const context = this.next("c");
				const result = this.next("r");
				this.push(`const ${context}=new MC(${this.storedPathExpr(segs)},${input});`);
				this.push(`const ${result}=${this.ref(node.fn)}(${input},${context});`);
				this.push(`if(${result} instanceof AE)return ${result};`);
				if (node.out === undefined) this.push(`${out}=${result};`);
				else this.emitProduce(node.out, result, segs, out);
				return;
			}
			case "alias": {
				let active = this.#activeAliases;
				if (active === undefined) {
					active = new Set();
					this.#activeAliases = active;
				}
				if (active.has(node)) {
					this.emitDelegate(node, v, segs, out);
					return;
				}
				active.add(node);
				try {
					this.emitProduce(node.resolve(), v, segs, out, failureData);
				} finally {
					active.delete(node);
				}
				return;
			}
			case "union": {
				const ok = this.next("u");
				this.push(`let ${ok}=false;`);
				const label = this.next("b");
				this.push(`${label}:{`);
				for (const m of node.members) {
					if (m.k !== "sub" && !hasMorph(m)) {
						this.push(`if(${this.predicate(m, v)}){${out}=${v};${ok}=true;break ${label};}`);
					}
				}
				for (const m of node.members) {
					if (m.k === "sub" || hasMorph(m)) {
						const runner = m.k === "sub" ? m.schema.run : m.k === "alias" ? boundWalk(m) : compile(m);
						const r = this.next("r");
						this.push(`const ${r}=${this.ref(runner)}(${v});`);
						this.push(`if(!(${r} instanceof AE)){${out}=${r};${ok}=true;break ${label};}`);
					}
				}
				this.push("}");
				this.push(
					`if(!${ok})return UF(${this.ref(node)},${failureData},${this.pathExpr(segs)},${JSON.stringify(expectedOf(node))});`,
				);
				return;
			}
			case "array": {
				let head = `Array.isArray(${v})`;
				if (node.min !== undefined) head += `&&${v}.length>=${node.min}`;
				if (node.max !== undefined) head += `&&${v}.length<=${node.max}`;
				this.push(`if(!(${head}))${this.fail(segs, expectedOf(node), failureData)};`);
				const arr = this.next("a");
				const i = this.next("i");
				const x = this.next("x");
				const el = this.next("t");
				this.push(`const ${arr}=new Array(${v}.length);`);
				this.push(`for(let ${i}=0;${i}<${v}.length;${i}++){const ${x}=${v}[${i}];let ${el};`);
				this.emitProduce(node.el, x, [...segs, { d: i }], el);
				this.push(`${arr}[${i}]=${el};}`);
				this.push(`${out}=${arr};`);
				return;
			}
			case "tuple": {
				const { postfixStart, prefixCount, requiredPrefix } = this.emitTupleShape(node, v, segs, failureData);
				const tuple = this.next("a");
				this.push(`const ${tuple}=[...${v}];`);
				for (let index = 0; index < node.prefix.length; index++) {
					const item = node.prefix[index];
					const input = `${v}[${index}]`;
					const output = `${tuple}[${index}]`;
					if (index >= requiredPrefix) this.push(`if(${index}<${prefixCount}){`);
					if (hasMorph(item.val)) this.emitProduce(item.val, input, [...segs, { d: String(index) }], output);
					else {
						this.emitCheck(item.val, input, [...segs, { d: String(index) }]);
						this.push(`${output}=${input};`);
					}
					if (index >= requiredPrefix) {
						if (item.hasDefault) {
							const defaultValue = item.defFactory ? `${this.ref(item.def)}()` : this.lit(item.def);
							this.push(`}else{${output}=${defaultValue};}`);
						} else {
							this.push("}");
						}
					}
				}
				if (node.variadic !== undefined) {
					const index = this.next("i");
					const input = this.next("x");
					this.push(
						`for(let ${index}=${prefixCount};${index}<${postfixStart};${index}++){const ${input}=${v}[${index}];`,
					);
					if (hasMorph(node.variadic)) {
						this.emitProduce(node.variadic, input, [...segs, { d: index }], `${tuple}[${index}]`);
					} else {
						this.emitCheck(node.variadic, input, [...segs, { d: index }]);
						this.push(`${tuple}[${index}]=${input};`);
					}
					this.push("}");
				}
				for (let index = 0; index < node.postfix.length; index++) {
					const inputIndex = index === 0 ? postfixStart : `${postfixStart}+${index}`;
					const input = `${v}[${inputIndex}]`;
					const output = `${tuple}[${inputIndex}]`;
					const item = node.postfix[index];
					if (hasMorph(item)) this.emitProduce(item, input, [...segs, { d: inputIndex }], output);
					else {
						this.emitCheck(item, input, [...segs, { d: inputIndex }]);
						this.push(`${output}=${input};`);
					}
				}
				this.push(`${out}=${tuple};`);
				return;
			}
			case "object": {
				this.push(
					`if(typeof ${v}!=="object"||${v}===null||Array.isArray(${v}))${this.fail(segs, "an object", failureData)};`,
				);
				const o = this.next("o");
				const fresh = node.extras !== "keep" && !node.index;
				this.push(fresh ? `const ${o}={};` : `const ${o}={...${v}};`);
				for (const p of node.props) {
					const present = `${JSON.stringify(p.key)} in ${v}`;
					const propSegs: PathSeg[] = [...segs, { s: p.key }];
					const av = access(v, p.key);
					const ao = access(o, p.key);
					const morphChild = hasMorph(p.val);
					const missing: string[] = [];
					if (p.hasDefault) {
						const dflt = p.defFactory ? `${this.ref(p.def)}()` : this.lit(p.def);
						missing.push(`${ao}=${dflt};`);
					} else if (!p.opt) {
						missing.push(`${this.fail(propSegs, expectedOf(p.val), "M")};`);
					}
					this.push(`if(!(${present})){${missing.join("")}}else{`);
					if (morphChild) {
						const t = this.next("t");
						this.push(`let ${t};`);
						this.emitProduce(p.val, av, propSegs, t);
						this.push(`${ao}=${t};`);
					} else {
						this.emitCheck(p.val, av, propSegs);
						if (fresh) this.push(`${ao}=${av};`);
					}
					this.push("}");
				}
				if (node.index) {
					const k = this.next("k");
					this.push(`for(const ${k} in ${v})if(own.call(${v},${k})){`);
					if (hasMorph(node.index)) {
						const t = this.next("t");
						this.push(`let ${t};`);
						this.emitProduce(node.index, `${v}[${k}]`, [...segs, { d: k }], t);
						this.push(`${o}[${k}]=${t};`);
					} else {
						this.emitCheck(node.index, `${v}[${k}]`, [...segs, { d: k }]);
					}
					this.push("}");
				} else if (node.extras === "reject") {
					const k = this.next("k");
					this.push(
						`for(const ${k} in ${v})if(own.call(${v},${k})&&!(${this.declaredCheck(node.props, k)}))${this.fail(
							[...segs, { d: k }],
							"removed (undeclared key)",
							`${v}[${k}]`,
						)};`,
					);
				}
				this.push(`${out}=${o};`);
				return;
			}
			case "refine": {
				const refined = this.next("t");
				this.push(`let ${refined};`);
				this.emitProduce(node.base, v, segs, refined, failureData);
				const failure = this.fail(segs, node.expected, refined);
				this.push(`try{if(!${this.ref(node.pred)}(${refined}))${failure};}catch{${failure};}`);
				this.push(`${out}=${refined};`);
				return;
			}
			case "intersection": {
				const current = this.next("t");
				this.push(`let ${current}=${v};`);
				for (const member of node.members) {
					if (hasMorph(member)) this.emitProduce(member, current, segs, current);
					else this.emitCheck(member, current, segs);
				}
				this.push(`${out}=${current};`);
				return;
			}
			default:
				this.emitDelegate(node, v, segs, out);
		}
	}

	build(ir: IR): (value: unknown) => unknown {
		let ret: string;
		if (hasMorph(ir)) {
			this.push("let o;");
			// body emitted below needs `o` declared first, so splice ordering:
			this.emitProduce(ir, "v", [], "o");
			ret = "o";
		} else {
			this.emitCheck(ir, "v", []);
			ret = "v";
		}
		const src = `return function(v){${this.#lines.join("")}return ${ret}}`;
		const make = new Function("R", "AE", "M", "PF", "UF", "MC", "own", src) as (
			refs: unknown[],
			ae: typeof OmpErrors,
			m: typeof MISSING,
			pf: typeof prefixErrors,
			uf: typeof unionFail,
			mc: typeof CompiledMorphContext,
			ownFn: typeof own,
		) => (value: unknown) => unknown;
		return make(this.#refs, OmpErrors, MISSING, prefixErrors, unionFail, CompiledMorphContext, own);
	}
}

function prefixErrors(errs: OmpErrors, parts: PropertyKey[]): OmpErrors {
	for (let i = parts.length - 1; i >= 0; i--) errs.prefix(parts[i]);
	return errs;
}

const kWalk = Symbol("omptype.boundWalk");

interface WalkTagged {
	[kWalk]?: (value: unknown) => unknown;
}

/** Cached interpreter closure for recursive aliases and predicate-only fallbacks. */
function boundWalk(node: IR): (value: unknown) => unknown {
	const tagged = node as IR & WalkTagged;
	let fn = tagged[kWalk];
	if (!fn) {
		fn = (value: unknown) => walk(node, value);
		tagged[kWalk] = fn;
	}
	return fn;
}

function resolvedRoot(ir: IR): IR {
	return ir.k === "alias" ? ir.resolve() : ir;
}

const compiledCache = new WeakMap<IR, (value: unknown) => unknown>();

/** Compile `ir` into a specialized validator. */
export function compile(ir: IR): (value: unknown) => unknown {
	const root = resolvedRoot(ir);
	let validator = compiledCache.get(root);
	if (validator === undefined) {
		validator = new Builder().build(root);
		compiledCache.set(root, validator);
	}
	return validator;
}

/** Generated source for inspection/debugging. */
export function compileToSource(ir: IR): string {
	const root = resolvedRoot(ir);
	const builder = new Builder();
	if (hasMorph(root)) {
		builder.push("let o;");
		builder.emitProduce(root, "v", [], "o");
		return `function(v){/* refs elided */return o}`;
	}
	builder.emitCheck(root, "v", []);
	return `function(v){/* refs elided */return v}`;
}
