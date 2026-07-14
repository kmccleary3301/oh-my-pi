import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;

export interface ArtifactEvidenceState {
  outerVerdict: string;
  supportLevel: string;
  payload: JsonObject;
  current: boolean;
}

export interface PredicateRecord {
  predicateHash: string;
  sourceRecordHash: string;
  recordHash: string;
  current: boolean;
  actual: unknown;
  expected: unknown;
}

export interface PredicateContext {
  records?: Readonly<Record<string, PredicateRecord>>;
  artifacts?: Readonly<Record<string, ArtifactEvidenceState>>;
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
  schemaDocuments: Map<string, JsonObject>;
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("predicate-numeric-invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new Error("predicate-json-invalid");
  const object = value as JsonObject;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function predicateBindingHash(predicate: JsonObject): string {
  return createHash("sha256").update(canonicalJson(predicate)).digest("hex");
}

export function predicateRecordHash(
  predicateHash: string,
  sourceRecordHash: string,
  current: boolean,
  actual: unknown,
  expected: unknown,
): string {
  return createHash("sha256")
    .update(
      `${predicateHash}\0${sourceRecordHash}\0${current ? "current" : "stale"}\0${canonicalJson(actual)}\0${canonicalJson(expected)}`,
    )
    .digest("hex");
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

function collectSchemaDocuments(value: unknown, documents: Map<string, JsonObject>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectSchemaDocuments(entry, documents);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = value as JsonObject;
  if (typeof object.$id === "string" && object.$id.length > 0) documents.set(object.$id, object);
  for (const entry of Object.values(object)) collectSchemaDocuments(entry, documents);
}

function resolvePointer(document: JsonObject, fragment: string): unknown {
  if (fragment === "" || fragment === "#") return document;
  if (!fragment.startsWith("#/")) return undefined;
  let current: unknown = document;
  for (const encoded of fragment.slice(2).split("/")) {
    const currentObject = schemaObject(current);
    if (!currentObject) return undefined;
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!(key in currentObject)) return undefined;
    current = currentObject[key];
  }
  return current;
}

function schemaObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function validateJsonSchema(
  value: unknown,
  schema: JsonObject,
  documents: Map<string, JsonObject>,
  root: JsonObject,
): boolean {
  if (typeof schema.$ref === "string") {
    const marker = schema.$ref.indexOf("#");
    const documentId = marker < 0 ? schema.$ref : schema.$ref.slice(0, marker);
    const fragment = marker < 0 ? "" : schema.$ref.slice(marker);
    const document = documentId.length === 0 ? root : documents.get(documentId);
    if (!document) return false;
    const target = schemaObject(resolvePointer(document, fragment));
    return target ? validateJsonSchema(value, target, documents, document) : false;
  }
  if (schema.const !== undefined && canonicalJson(value) !== canonicalJson(schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => canonicalJson(entry) === canonicalJson(value))) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((entry) => {
    const child = schemaObject(entry);
    return child ? validateJsonSchema(value, child, documents, root) : false;
  })) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((entry) => {
    const child = schemaObject(entry);
    return child ? validateJsonSchema(value, child, documents, root) : false;
  })) return false;
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((entry) => {
      const child = schemaObject(entry);
      return child ? validateJsonSchema(value, child, documents, root) : false;
    }).length;
    if (matches !== 1) return false;
  }
  if (schema.not !== undefined) {
    const child = schemaObject(schema.not);
    if (!child || validateJsonSchema(value, child, documents, root)) return false;
  }
  if (typeof schema.type === "string") {
    const typeMatches =
      (schema.type === "object" && !!value && typeof value === "object" && !Array.isArray(value)) ||
      (schema.type === "array" && Array.isArray(value)) ||
      (schema.type === "string" && typeof value === "string") ||
      (schema.type === "boolean" && typeof value === "boolean") ||
      (schema.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
      (schema.type === "integer" && typeof value === "number" && Number.isInteger(value)) ||
      (schema.type === "null" && value === null);
    if (!typeMatches) return false;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return false;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.uniqueItems === true && new Set(value.map(canonicalJson)).size !== value.length) return false;
    const itemSchema = schemaObject(schema.items);
    if (itemSchema && !value.every((entry) => validateJsonSchema(entry, itemSchema, documents, root))) return false;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as JsonObject;
    const required = Array.isArray(schema.required) ? schema.required : [];
    if (required.some((key) => typeof key !== "string" || !(key in object))) return false;
    const properties = schemaObject(schema.properties) ?? {};
    for (const [key, entry] of Object.entries(object)) {
      const propertySchema = schemaObject(properties[key]);
      if (propertySchema) {
        if (!validateJsonSchema(entry, propertySchema, documents, root)) return false;
      } else if (schema.additionalProperties === false) {
        return false;
      }
    }
  }
  return true;
}

function requiredCollectionsNonempty(payload: JsonObject, schema: JsonObject): boolean {
  const required = Array.isArray(schema.required) ? schema.required : [];
  const properties = schemaObject(schema.properties) ?? {};
  for (const key of required) {
    if (typeof key !== "string") return false;
    const value = payload[key];
    if (Array.isArray(value) && value.length === 0) return false;
    const childSchema = schemaObject(properties[key]);
    if (childSchema?.type === "object") {
      const childPayload = schemaObject(value);
      if (!childPayload || !requiredCollectionsNonempty(childPayload, childSchema)) return false;
    }
  }
  return true;
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

function recordHandler(predicate: JsonObject, context: PredicateContext, state: EvaluationState): boolean {
  const predicateHash = predicateBindingHash(predicate);
  const record = context.records?.[predicateHash];
  if (!record) {
    state.errors.push("predicate-record-missing");
    return false;
  }
  if (
    record.predicateHash !== predicateHash ||
    !/^[0-9a-f]{64}$/.test(record.sourceRecordHash) ||
    record.recordHash !==
      predicateRecordHash(
        record.predicateHash,
        record.sourceRecordHash,
        record.current,
        record.actual,
        record.expected,
      )
  ) {
    state.errors.push("predicate-record-binding-invalid");
    return false;
  }
  if (!record.current) {
    state.errors.push("predicate-record-stale");
    return false;
  }
  return canonicalJson(record.actual) === canonicalJson(record.expected);
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
  if (typeof predicate.payloadConstraintsFromSchema !== "string") {
    state.errors.push("predicate-field-missing");
    return false;
  }
  const payloadSchemas = schemaObject(state.spec.evidencePayloadSchemas);
  const payloadDefinition = payloadSchemas
    ? schemaObject(payloadSchemas[predicate.payloadConstraintsFromSchema])
    : undefined;
  const payloadSchema = payloadDefinition ? schemaObject(payloadDefinition.jsonSchema) : undefined;
  if (!payloadDefinition || !payloadSchema) {
    state.errors.push("evidence-schema-missing");
    return false;
  }
  if (
    !validateJsonSchema(artifact.payload, payloadSchema, state.schemaDocuments, payloadSchema) ||
    !requiredCollectionsNonempty(artifact.payload, payloadSchema)
  ) {
    state.errors.push("evidence-schema-invalid");
    return false;
  }
  const semanticPredicates = payloadDefinition.semanticPredicates;
  if (!Array.isArray(semanticPredicates) || semanticPredicates.length === 0) {
    state.errors.push("evidence-semantic-predicates-missing");
    return false;
  }
  let semanticValid = true;
  for (const semanticPredicate of semanticPredicates) {
    if (!evaluateNode(semanticPredicate, context, state)) semanticValid = false;
  }
  if (!semanticValid) {
    if (!state.errors.includes("predicate-record-missing") && !state.errors.includes("predicate-record-binding-invalid")) {
      state.errors.push("evidence-semantic-invalid");
    }
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
  private readonly schemaDocuments: Map<string, JsonObject>;

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
    for (const op of registeredOperators) this.handlers.set(op, recordHandler);
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
    this.schemaDocuments = new Map();
    collectSchemaDocuments(this.spec, this.schemaDocuments);
    this.implementedOperators = [...this.handlers.keys()].sort();
  }

  validateShape(predicate: unknown): PredicateEvaluation {
    if (!predicate || typeof predicate !== "object" || Array.isArray(predicate)) {
      return { value: false, errors: ["predicate-shape-invalid"], evaluatedOperatorCount: 0 };
    }
    const object = predicate as JsonObject;
    if (typeof object.op !== "string" || object.op.length === 0) {
      return { value: false, errors: ["predicate-operator-missing"], evaluatedOperatorCount: 0 };
    }
    if (!this.handlers.has(object.op)) {
      return { value: false, errors: ["predicate-operator-unknown"], evaluatedOperatorCount: 0 };
    }
    if (!this.shapes.get(object.op)?.has(predicateSignature(object))) {
      return { value: false, errors: ["predicate-schema-violation"], evaluatedOperatorCount: 0 };
    }
    return { value: true, errors: [], evaluatedOperatorCount: 0 };
  }

  evaluate(predicate: unknown, context: PredicateContext = {}): PredicateEvaluation {
    const state: EvaluationState = {
      errors: [],
      evaluatedOperatorCount: 0,
      spec: this.spec,
      handlers: this.handlers,
      shapes: this.shapes,
      schemaDocuments: this.schemaDocuments,
    };
    const value = evaluateNode(predicate, context, state);
    return { value: value && state.errors.length === 0, errors: state.errors, evaluatedOperatorCount: state.evaluatedOperatorCount };
  }
}
