export type JsonObject = Record<string, unknown>;

export interface ArtifactEvidenceState {
  outerVerdict: string;
  supportLevel: string;
  schemaValid: boolean;
  semanticPredicatesValid: boolean;
  requiredCollectionsNonempty: boolean;
  current: boolean;
}

export interface PredicateContext {
  facts?: Record<string, boolean>;
  artifacts?: Record<string, ArtifactEvidenceState>;
}

export interface PredicateEvaluation {
  value: boolean;
  errors: string[];
  evaluatedOperatorCount: number;
}

type OperatorHandler = (predicate: JsonObject, context: PredicateContext, state: EvaluationState) => boolean;

type PredicateShapes = Map<string, Set<string>>;

interface EvaluationState {
  errors: string[];
  evaluatedOperatorCount: number;
  spec: JsonObject;
  handlers: Map<string, OperatorHandler>;
  shapes: PredicateShapes;
}

function predicateObject(value: unknown, state: EvaluationState): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    state.errors.push("predicate-shape-invalid");
    return undefined;
  }
  return value as JsonObject;
}

function valueKind(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function predicateSignature(predicate: JsonObject): string {
  return Object.entries(predicate)
    .filter(([key]) => key !== "op")
    .map(([key, value]) => `${key}:${valueKind(value)}`)
    .sort()
    .join("|");
}

function collectPredicateShapes(value: unknown, shapes: PredicateShapes): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectPredicateShapes(entry, shapes);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as JsonObject;
  if (typeof object.op === "string" && object.op.length > 0) {
    let signatures = shapes.get(object.op);
    if (!signatures) {
      signatures = new Set<string>();
      shapes.set(object.op, signatures);
    }
    signatures.add(predicateSignature(object));
  }
  for (const entry of Object.values(object)) collectPredicateShapes(entry, shapes);
}

function evaluateNode(value: unknown, context: PredicateContext, state: EvaluationState): boolean {
  const predicate = predicateObject(value, state);
  if (!predicate) return false;
  if (typeof predicate.op !== "string" || predicate.op.length === 0) {
    state.errors.push("predicate-operator-missing");
    return false;
  }
  const handler = state.handlers.get(predicate.op);
  if (!handler) {
    state.errors.push("predicate-operator-unknown");
    return false;
  }
  if (!state.shapes.get(predicate.op)?.has(predicateSignature(predicate))) {
    state.errors.push("predicate-schema-violation");
    return false;
  }
  state.evaluatedOperatorCount += 1;
  try {
    return handler(predicate, context, state) === true;
  } catch {
    state.errors.push("predicate-handler-failed");
    return false;
  }
}

function factHandler(predicate: JsonObject, context: PredicateContext, state: EvaluationState): boolean {
  const op = predicate.op as string;
  const fact = context.facts?.[op];
  if (typeof fact !== "boolean") {
    state.errors.push("predicate-fact-missing");
    return false;
  }
  return fact;
}

function andHandler(predicate: JsonObject, context: PredicateContext, state: EvaluationState): boolean {
  if (!Array.isArray(predicate.args) || predicate.args.length === 0) {
    state.errors.push("predicate-required-collection-empty");
    return false;
  }
  let result = true;
  for (const argument of predicate.args) {
    if (!evaluateNode(argument, context, state)) result = false;
  }
  return result;
}

function notHandler(predicate: JsonObject, context: PredicateContext, state: EvaluationState): boolean {
  if (!("arg" in predicate)) {
    state.errors.push("predicate-field-missing");
    return false;
  }
  const errorCount = state.errors.length;
  const inner = evaluateNode(predicate.arg, context, state);
  if (state.errors.length !== errorCount) return false;
  return !inner;
}

function artifactSupportsAcceptanceHandler(
  predicate: JsonObject,
  context: PredicateContext,
  state: EvaluationState,
): boolean {
  if (
    typeof predicate.artifactId !== "string" ||
    typeof predicate.requiredOuterVerdict !== "string" ||
    typeof predicate.requiredSupportLevel !== "string"
  ) {
    state.errors.push("predicate-field-missing");
    return false;
  }
  const artifact = context.artifacts?.[predicate.artifactId];
  if (!artifact) {
    state.errors.push("evidence-missing");
    return false;
  }
  if (!artifact.current) {
    state.errors.push("evidence-stale");
    return false;
  }
  if (!artifact.schemaValid || !artifact.semanticPredicatesValid || !artifact.requiredCollectionsNonempty) {
    state.errors.push("evidence-invalid");
    return false;
  }
  if (
    artifact.outerVerdict !== predicate.requiredOuterVerdict ||
    artifact.supportLevel !== predicate.requiredSupportLevel
  ) {
    state.errors.push("evidence-verdict-failed");
    return false;
  }
  return true;
}

function canonicalCloseoutHandler(predicate: JsonObject, context: PredicateContext, state: EvaluationState): boolean {
  if (predicate.jsonPointer !== "#/closeoutPredicate" || predicate.requireResult !== true) {
    state.errors.push("canonical-closeout-pointer-invalid");
    return false;
  }
  if (!("closeoutPredicate" in state.spec)) {
    state.errors.push("canonical-closeout-missing");
    return false;
  }
  return evaluateNode(state.spec.closeoutPredicate, context, state);
}

export class PredicateEngine {
  readonly implementedOperators: readonly string[];
  private readonly handlers: Map<string, OperatorHandler>;
  private readonly shapes: PredicateShapes;

  constructor(private readonly spec: JsonObject) {
    const engine = spec.predicateEngine;
    if (!engine || typeof engine !== "object" || Array.isArray(engine)) {
      throw new Error("predicate-engine-definition-missing");
    }
    const engineObject = engine as JsonObject;
    const registered = engineObject.registeredOperators;
    if (!Array.isArray(registered) || registered.length === 0 || registered.some((op) => typeof op !== "string" || op.length === 0)) {
      throw new Error("predicate-registry-invalid");
    }
    if (new Set(registered).size !== registered.length) throw new Error("predicate-registry-duplicate");
    const registeredOperators = registered as string[];

    this.handlers = new Map<string, OperatorHandler>();
    for (const op of registeredOperators) this.handlers.set(op, factHandler);
    const specialHandlers: Record<string, OperatorHandler> = {
      and: andHandler,
      artifactSupportsAcceptance: artifactSupportsAcceptanceHandler,
      evaluateCanonicalCloseoutPredicate: canonicalCloseoutHandler,
      not: notHandler,
      true: () => true,
    };
    for (const [op, handler] of Object.entries(specialHandlers)) {
      if (!this.handlers.has(op)) throw new Error("predicate-required-operator-unregistered");
      this.handlers.set(op, handler);
    }
    this.shapes = new Map();
    collectPredicateShapes(this.spec, this.shapes);
    this.implementedOperators = [...this.handlers.keys()].sort();
  }

  evaluate(predicate: unknown, context: PredicateContext = {}): PredicateEvaluation {
    const state: EvaluationState = {
      errors: [],
      evaluatedOperatorCount: 0,
      spec: this.spec,
      handlers: this.handlers,
      shapes: this.shapes,
    };
    const value = evaluateNode(predicate, context, state);
    return { value: value && state.errors.length === 0, errors: state.errors, evaluatedOperatorCount: state.evaluatedOperatorCount };
  }
}
