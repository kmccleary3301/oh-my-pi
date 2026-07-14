import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PredicateEngine, type JsonObject } from "./predicate-engine.ts";

export const FROZEN_SPEC_SHA256 = "990a200837471ba78e55484a0b001002f7c71074f07ef3a698f12e5b3ad553de";
export const FROZEN_SPEC_SCHEMA = "bb.tui.p29.loop-spec.v4.41";
const ORACLE_OBJECT = "3047c27c332c5629c8e063283d349384c10c9a56";
const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/BB_TUI_P29_BB_OMP_TOTAL_FULFILLMENT_PR_DAG.json",
);
const EXPECTED_TOP_LEVEL_KEYS = [
  "acceptanceCatalog",
  "artifactCatalog",
  "attemptLimits",
  "capabilityFamilyOwnershipManifest",
  "closeoutPredicate",
  "evidenceItemSchemaDocument",
  "evidenceItemSchemas",
  "evidencePayloadSchemas",
  "externalArtifacts",
  "gateFrontierPolicy",
  "gates",
  "gitObjectIdPolicy",
  "leaseOwnedStatesByKind",
  "packetKindTerminalStates",
  "packetTransitions",
  "packets",
  "plan",
  "predicateEngine",
  "predicateLanguage",
  "programTransitions",
  "promotionPolicyRegistry",
  "promotionScannerBootstrap",
  "recordSchemas",
  "repositories",
  "requiredPacketIds",
  "schemaVersion",
  "seededSimulations",
  "simulationFixtureCatalog",
  "simulationMetaEvents",
  "sourcePins",
  "stateEnums",
  "status",
  "testCommandRegistry",
  "testOutputQuarantinePolicy",
  "trackingEpic",
  "validatorRules",
  "wakeSubscriptionKinds",
] as const;
const EXPECTED_COMMAND_IDS = [
  "benchmark",
  "build-install-launch",
  "ci-suite",
  "focused-test",
  "lint",
  "package-lifecycle",
  "parity-differential",
  "rollback-validation",
  "scenario-ghostty",
  "scenario-pty",
  "scenario-vscode",
  "scenario-wezterm",
  "security-negative-control",
  "source-census",
  "static-typecheck",
  "unit-integration",
] as const;
const COMMAND_REGISTRY_HASH = "5aa0d5056b6ff29f1fe82015afe073de9ee1bbbcbd9bb225b41e18f1814d9f62";
const REQUIRED_NEGATIVE_SIMULATIONS = [
  "failed-evidence",
  "final-index-scan-cycle-attempt",
  "raw-rollback-verification-command-in-structured-inline-scan-evidence",
  "raw-test-command-in-structured-inline-scan-evidence",
  "rejected-final-review",
  "stale-post-distribution-replay-accepted",
  "unresolved-json-schema-ref",
] as const;

export class LoopSpecViolation extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LoopSpecViolation";
  }
}

function fail(code: string): never {
  throw new LoopSpecViolation(code);
}

function objectValue(value: unknown, code: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as JsonObject;
}

function objectArray(value: unknown, code: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) fail(code);
  return value as JsonObject[];
}

function stringArray(value: unknown, code: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) fail(code);
  if (!allowEmpty && value.length === 0) fail(`${code}-empty`);
  return value as string[];
}

function assertUnique(values: readonly string[], code: string): void {
  if (new Set(values).size !== values.length) fail(code);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function walk(value: unknown, path: string, visit: (node: JsonObject, path: string) => void): void {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const object = value as JsonObject;
    visit(object, path);
    for (const [key, child] of Object.entries(object)) {
      walk(child, `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`, visit);
    }
  } else if (Array.isArray(value)) {
    value.forEach((child, index) => walk(child, `${path}/${index}`, visit));
  }
}

function catalog(value: unknown, code: string): Record<string, JsonObject> {
  const object = objectValue(value, code);
  for (const entry of Object.values(object)) objectValue(entry, `${code}-entry`);
  return object as Record<string, JsonObject>;
}

function idsFromObjects(values: JsonObject[], code: string): string[] {
  const ids = values.map((value) => {
    if (typeof value.id !== "string" || value.id.length === 0) fail(`${code}-id`);
    return value.id;
  });
  assertUnique(ids, `${code}-duplicate`);
  return ids;
}

function assertClosedTopLevel(spec: JsonObject): void {
  if (!sameStrings(Object.keys(spec), EXPECTED_TOP_LEVEL_KEYS)) fail("top-level-shape-open");
  if (spec.schemaVersion !== FROZEN_SPEC_SCHEMA || spec.predicateLanguage !== "bb.loop.expr.v1") {
    fail("spec-schema-drift");
  }
  const sourcePins = objectValue(spec.sourcePins, "source-pins-invalid");
  if (sourcePins.ompRelease !== "v16.5.0" || sourcePins.ompReleaseCommit !== ORACLE_OBJECT) {
    fail("oracle-pin-drift");
  }
}

function validateOwnershipAndReferences(spec: JsonObject): {
  packetCount: number;
  gateCount: number;
  artifactCount: number;
  acceptanceCount: number;
} {
  const packets = objectArray(spec.packets, "packets-invalid");
  const packetIds = idsFromObjects(packets, "packet");
  const packetIdSet = new Set(packetIds);
  const requiredIds = stringArray(spec.requiredPacketIds, "required-packets", false);
  assertUnique(requiredIds, "required-packets-duplicate");
  const declaredRequired = packets.filter((packet) => packet.required === true).map((packet) => packet.id as string);
  if (!sameStrings(requiredIds, declaredRequired)) fail("required-packet-inventory-mismatch");

  const gates = objectArray(spec.gates, "gates-invalid");
  const gateIds = idsFromObjects(gates, "gate");
  const gateIdSet = new Set(gateIds);
  const acceptances = catalog(spec.acceptanceCatalog, "acceptance-catalog-invalid");
  const artifacts = catalog(spec.artifactCatalog, "artifact-catalog-invalid");
  const externalArtifactCatalog = catalog(spec.externalArtifacts, "external-artifacts-invalid");
  const externalArtifacts = Object.keys(externalArtifactCatalog);
  if (externalArtifacts.length === 0) fail("external-artifacts-empty");
  for (const artifact of Object.values(externalArtifactCatalog)) {
    stringArray(artifact.bindingKeys, "external-artifact-binding-keys", false);
    stringArray(artifact.requiredFields, "external-artifact-required-fields", false);
    if (artifact.originConstraints !== undefined) {
      stringArray(artifact.originConstraints, "external-artifact-origin-constraints", false);
    }
    if (artifact.invalidationKeys !== undefined) {
      stringArray(artifact.invalidationKeys, "external-artifact-invalidation-keys", false);
    }
    if (
      typeof artifact.producerRole !== "string" ||
      artifact.producerRole.length === 0 ||
      typeof artifact.recordSchema !== "string" ||
      artifact.recordSchema.length === 0 ||
      typeof artifact.requiredVerdict !== "string" ||
      artifact.requiredVerdict.length === 0
    ) {
      fail("external-artifact-record-malformed");
    }
  }

  const acceptanceClaims = new Map<string, string>();
  const artifactClaims = new Map<string, string>();
  for (const packet of packets) {
    const packetId = packet.id as string;
    if (packet.initialState !== "BLOCKED") fail("packet-initial-state-invalid");
    for (const dependency of stringArray(packet.dependsOnPackets, "packet-dependencies")) {
      if (!packetIdSet.has(dependency)) fail("packet-dependency-unresolved");
    }
    for (const gate of stringArray(packet.requiresGates, "packet-required-gates")) {
      if (!gateIdSet.has(gate)) fail("packet-gate-unresolved");
    }
    const acceptanceIds = stringArray(packet.acceptanceIds, "packet-acceptances", false);
    assertUnique(acceptanceIds, "packet-acceptance-duplicate");
    for (const acceptanceId of acceptanceIds) {
      if (!(acceptanceId in acceptances)) fail("packet-acceptance-unresolved");
      if (acceptanceClaims.has(acceptanceId)) fail("acceptance-owner-duplicate");
      acceptanceClaims.set(acceptanceId, packetId);
    }
    const artifactIds = stringArray(packet.producesArtifacts, "packet-artifacts");
    assertUnique(artifactIds, "packet-artifact-duplicate");
    for (const artifactId of artifactIds) {
      if (!(artifactId in artifacts)) fail("packet-artifact-unresolved");
      if (artifactClaims.has(artifactId)) fail("artifact-owner-duplicate");
      artifactClaims.set(artifactId, packetId);
    }
  }

  if (!sameStrings([...acceptanceClaims.keys()], Object.keys(acceptances))) fail("acceptance-owner-missing");
  if (!sameStrings([...artifactClaims.keys()], Object.keys(artifacts))) fail("artifact-owner-missing");
  for (const [acceptanceId, acceptance] of Object.entries(acceptances)) {
    const owner = acceptance.ownerPacket;
    if (typeof owner !== "string" || owner !== acceptanceClaims.get(acceptanceId)) fail("acceptance-owner-mismatch");
    const predicate = objectValue(acceptance.predicate, "acceptance-predicate-invalid");
    if (predicate.op === "artifactSupportsAcceptance") {
      if (typeof predicate.artifactId !== "string" || !(predicate.artifactId in artifacts)) {
        fail("acceptance-artifact-unresolved");
      }
      const artifact = artifacts[predicate.artifactId];
      if (
        artifact.producerPacket !== owner ||
        typeof predicate.payloadConstraintsFromSchema !== "string" ||
        predicate.payloadConstraintsFromSchema !== artifact.payloadSchema
      ) {
        fail("acceptance-artifact-owner-schema-mismatch");
      }
    }
  }
  for (const [artifactId, artifact] of Object.entries(artifacts)) {
    if (artifact.producerPacket !== artifactClaims.get(artifactId)) fail("artifact-producer-mismatch");
    if (typeof artifact.payloadSchema !== "string") fail("artifact-payload-schema-missing");
  }

  const externalMatches = (artifactId: string): boolean =>
    externalArtifacts.some((pattern) => {
      const marker = pattern.indexOf("{instance}");
      return marker < 0
        ? artifactId === pattern
        : artifactId.startsWith(pattern.slice(0, marker)) && artifactId.endsWith(pattern.slice(marker + "{instance}".length));
    });

  for (const gate of gates) {
    const gateId = gate.id as string;
    const requiredPackets = stringArray(gate.requiresPackets, "gate-required-packets");
    const requiredArtifacts = stringArray(gate.requiresArtifacts, "gate-required-artifacts");
    const consumers = stringArray(gate.consumers, "gate-consumers");
    assertUnique(requiredPackets, "gate-required-packet-duplicate");
    assertUnique(requiredArtifacts, "gate-required-artifact-duplicate");
    assertUnique(consumers, "gate-consumer-duplicate");
    if (requiredPackets.some((id) => !packetIdSet.has(id))) fail("gate-packet-unresolved");
    if (requiredArtifacts.some((id) => !(id in artifacts) && !externalMatches(id))) fail("gate-artifact-unresolved");
    if (consumers.some((id) => !packetIdSet.has(id))) fail("gate-consumer-unresolved");
    for (const packet of packets) {
      const packetRequires = stringArray(packet.requiresGates, "packet-required-gates").includes(gateId);
      if (packetRequires !== consumers.includes(packet.id as string)) fail("gate-consumer-asymmetry");
    }
  }

  return {
    packetCount: packets.length,
    gateCount: gates.length,
    artifactCount: Object.keys(artifacts).length,
    acceptanceCount: Object.keys(acceptances).length,
  };
}

function validateGraph(spec: JsonObject): void {
  const packets = objectArray(spec.packets, "packets-invalid");
  const gates = objectArray(spec.gates, "gates-invalid");
  const artifacts = catalog(spec.artifactCatalog, "artifact-catalog-invalid");
  const graph = new Map<string, Set<string>>();
  const addNode = (id: string): void => {
    if (!graph.has(id)) graph.set(id, new Set());
  };
  const addEdge = (from: string, to: string): void => {
    addNode(from);
    addNode(to);
    graph.get(from)?.add(to);
  };
  for (const packet of packets) {
    const id = `packet:${packet.id as string}`;
    addNode(id);
    for (const dependency of stringArray(packet.dependsOnPackets, "packet-dependencies")) {
      addEdge(`packet:${dependency}`, id);
    }
  }
  for (const gate of gates) {
    const gateNode = `gate:${gate.id as string}`;
    addNode(gateNode);
    for (const packet of stringArray(gate.requiresPackets, "gate-required-packets")) addEdge(`packet:${packet}`, gateNode);
    for (const artifactId of stringArray(gate.requiresArtifacts, "gate-required-artifacts")) {
      const artifact = artifacts[artifactId];
      if (artifact && typeof artifact.producerPacket === "string") addEdge(`packet:${artifact.producerPacket}`, gateNode);
    }
    for (const consumer of stringArray(gate.consumers, "gate-consumers")) addEdge(gateNode, `packet:${consumer}`);
  }

  const colors = new Map<string, number>();
  const visit = (node: string): void => {
    const color = colors.get(node) ?? 0;
    if (color === 1) fail("expanded-dependency-cycle");
    if (color === 2) return;
    colors.set(node, 1);
    for (const successor of graph.get(node) ?? []) visit(successor);
    colors.set(node, 2);
  };
  for (const node of graph.keys()) visit(node);

  const target = "packet:G16";
  for (const packetId of stringArray(spec.requiredPacketIds, "required-packets", false)) {
    const seen = new Set<string>();
    const queue = [`packet:${packetId}`];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const successor of graph.get(current) ?? []) queue.push(successor);
    }
    if (!seen.has(target)) fail("required-packet-not-reaching-closeout");
  }
}

function validateTransitionsAndClosure(spec: JsonObject): void {
  const packetTransitions = objectArray(spec.packetTransitions, "packet-transitions-invalid");
  const programTransitions = objectArray(spec.programTransitions, "program-transitions-invalid");
  const stateEnums = objectValue(spec.stateEnums, "state-enums-invalid");
  const packetStates = new Set(stringArray(stateEnums.packet, "packet-states", false));
  const programStates = new Set(stringArray(stateEnums.program, "program-states", false));
  const seen = new Set<string>();
  for (const transition of packetTransitions) {
    if (typeof transition.event !== "string" || transition.event.length === 0) {
      fail("packet-transition-reference-invalid");
    }
    const sources =
      typeof transition.source === "string"
        ? [transition.source]
        : stringArray(transition.source, "packet-transition-sources", false);
    if (
      sources.some((source) => source !== "*" && !packetStates.has(source)) ||
      typeof transition.target !== "string" ||
      (transition.target !== "$same" && !packetStates.has(transition.target)) ||
      (transition.target === "$same" && sources.includes("*"))
    ) {
      fail("packet-transition-reference-invalid");
    }
    const signature = `${transition.event}\0${JSON.stringify(transition.source)}\0${transition.target}\0${JSON.stringify(transition.packetKinds ?? null)}`;
    if (seen.has(signature)) fail("transition-duplicate");
    seen.add(signature);
    if (sources.includes("CLOSED") || transition.target === "CLOSED") fail("packet-closed-transition-illegal");
  }
  for (const transition of programTransitions) {
    if (
      typeof transition.event !== "string" ||
      typeof transition.source !== "string" ||
      typeof transition.target !== "string" ||
      !programStates.has(transition.source) ||
      !programStates.has(transition.target)
    ) {
      fail("program-transition-reference-invalid");
    }
    const signature = `${transition.event}\0${transition.source}\0${transition.target}`;
    if (seen.has(signature)) fail("transition-duplicate");
    seen.add(signature);
  }
  const closed = programTransitions.filter((transition) => transition.target === "CLOSED");
  if (closed.length !== 1 || programTransitions.some((transition) => transition.source === "CLOSED")) {
    fail("closed-transition-not-sole");
  }
  const expectedGuard = {
    op: "and",
    args: [
      { op: "packetCompleteByKind", id: "G16", expectedState: "ADMIN_COMPLETED" },
      { op: "evaluateCanonicalCloseoutPredicate", jsonPointer: "#/closeoutPredicate", requireResult: true },
    ],
  };
  if (
    closed[0].source !== "FINAL_AUDIT_APPROVED" ||
    closed[0].event !== "PROGRAM_ADVANCE" ||
    !sameJson(closed[0].guard, expectedGuard)
  ) {
    fail("closed-transition-guard-not-canonical-pointer");
  }
  const rules = objectArray(spec.validatorRules, "validator-rules-invalid");
  const ruleIds = idsFromObjects(rules, "validator-rule");
  const closeoutIndex = ruleIds.indexOf("closeout");
  const canonicalIndex = ruleIds.indexOf("canonical-closeout-single-source");
  if (closeoutIndex < 0 || canonicalIndex < 0) fail("closeout-validator-rule-missing");
  if (
    !sameJson(rules[closeoutIndex].predicate, {
      op: "evaluateCanonicalCloseoutPredicate",
      jsonPointer: "#/closeoutPredicate",
      requireResult: true,
    }) ||
    !sameJson(rules[canonicalIndex].predicate, {
      op: "closedEdgeAndCloseoutValidatorDereferenceExactCanonicalPredicate",
      closedTarget: "CLOSED",
      validatorRuleId: "closeout",
      jsonPointer: "#/closeoutPredicate",
    })
  ) {
    fail("canonical-closeout-rule-invalid");
  }
}

function resolveJsonPointer(document: unknown, fragment: string): unknown {
  if (fragment === "" || fragment === "#") return document;
  if (!fragment.startsWith("#/")) fail("json-schema-ref-fragment-invalid");
  let current = document;
  for (const encoded of fragment.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
      fail("json-schema-ref-unresolved");
    }
    current = (current as JsonObject)[key];
  }
  return current;
}

function validateJsonSchemas(spec: JsonObject): void {
  const payloadSchemas = catalog(spec.evidencePayloadSchemas, "payload-schemas-invalid");
  const itemSchemas = catalog(spec.evidenceItemSchemas, "item-schemas-invalid");
  const itemDocument = objectValue(spec.evidenceItemSchemaDocument, "item-schema-document-invalid");
  const itemDefinitions = catalog(itemDocument.$defs, "item-schema-definitions-invalid");
  if (!sameJson(itemDefinitions, itemSchemas)) fail("item-schema-mirror-drift");
  const predicateEngine = objectValue(spec.predicateEngine, "predicate-engine-invalid");
  const schemaRegistry = objectValue(predicateEngine.schemaRegistry, "schema-registry-invalid");
  const payloadIds = objectValue(schemaRegistry.payloadSchemaIds, "payload-schema-ids-invalid");
  if (!sameStrings(Object.keys(payloadSchemas), Object.keys(payloadIds))) fail("payload-schema-registry-mismatch");

  const documents = new Map<string, unknown>();
  if (typeof itemDocument.$id !== "string") fail("item-schema-id-missing");
  documents.set(itemDocument.$id, itemDocument);
  for (const [name, definition] of Object.entries(payloadSchemas)) {
    const schema = objectValue(definition.jsonSchema, "payload-json-schema-missing");
    if (typeof schema.$id !== "string" || payloadIds[name] !== schema.$id) fail("payload-schema-id-mismatch");
    if (documents.has(schema.$id)) fail("json-schema-id-duplicate");
    documents.set(schema.$id, schema);
  }

  for (const [documentId, document] of documents) {
    walk(document, "#", (node) => {
      if (node.type === "object") {
        if (!("additionalProperties" in node)) fail("json-schema-object-not-closed");
        if (node.required !== undefined) {
          const required = stringArray(node.required, "json-schema-required-invalid");
          assertUnique(required, "json-schema-required-duplicate");
          const properties = objectValue(node.properties, "json-schema-properties-missing");
          if (required.some((key) => !(key in properties))) fail("json-schema-required-property-unresolved");
        }
      }
      if (node.$ref !== undefined) {
        if (typeof node.$ref !== "string") fail("json-schema-ref-invalid");
        const hash = node.$ref.indexOf("#");
        const targetId = hash < 0 ? node.$ref : node.$ref.slice(0, hash);
        const fragment = hash < 0 ? "" : node.$ref.slice(hash);
        const target = targetId.length === 0 ? document : documents.get(targetId);
        if (!target) fail("json-schema-ref-unresolved");
        resolveJsonPointer(target, fragment);
      }
    });
    if (documentId.length === 0) fail("json-schema-id-empty");
  }

  const artifacts = catalog(spec.artifactCatalog, "artifact-catalog-invalid");
  for (const artifact of Object.values(artifacts)) {
    if (typeof artifact.payloadSchema !== "string" || !(artifact.payloadSchema in payloadSchemas)) {
      fail("artifact-payload-schema-unresolved");
    }
  }
}

function validateCommandSafety(spec: JsonObject): void {
  const registry = objectValue(spec.testCommandRegistry, "command-registry-invalid");
  const commandIds = stringArray(registry.commandIds, "command-ids-invalid", false);
  assertUnique(commandIds, "command-id-duplicate");
  if (
    registry.schemaVersion !== "bb.loop.test-command-registry.v1" ||
    registry.rawInvocationStorage !== "private-quarantine-only" ||
    registry.registryHash !== COMMAND_REGISTRY_HASH ||
    !sameStrings(commandIds, EXPECTED_COMMAND_IDS) ||
    commandIds.some((id) => !/^[a-z][a-z0-9-]*$/.test(id))
  ) {
    fail("command-registry-unsafe");
  }
  const quarantine = objectValue(spec.testOutputQuarantinePolicy, "output-quarantine-invalid");
  if (
    quarantine.captureBoundary !== "private-quarantine-only" ||
    !stringArray(quarantine.requirements, "output-quarantine-requirements", false).includes("noRawOutputInEvidenceOrLogs")
  ) {
    fail("output-quarantine-unsafe");
  }
}

function validatePredicatesAndSimulations(spec: JsonObject): {
  operatorCount: number;
  simulationCount: number;
  simulationReplayHash: string;
} {
  const predicateDefinition = objectValue(spec.predicateEngine, "predicate-engine-invalid");
  const registered = stringArray(predicateDefinition.registeredOperators, "predicate-operators-invalid", false);
  assertUnique(registered, "predicate-operator-duplicate");
  const registeredSet = new Set(registered);
  const used = new Set<string>();
  walk(spec, "#", (node) => {
    if (typeof node.op === "string") {
      if (node.op.length === 0) fail("predicate-op-invalid");
      used.add(node.op);
    }
  });
  if (!sameStrings([...used], registered)) fail("predicate-operator-coverage-incomplete");
  const engine = new PredicateEngine(spec);
  if (!sameStrings(engine.implementedOperators, registered)) fail("predicate-implementation-coverage-incomplete");

  const transitions = [
    ...objectArray(spec.packetTransitions, "packet-transitions-invalid"),
    ...objectArray(spec.programTransitions, "program-transitions-invalid"),
  ];
  const knownEvents = new Set(transitions.map((transition) => transition.event as string));
  const metaEvents = objectValue(spec.simulationMetaEvents, "simulation-events-invalid");
  for (const event of Object.keys(metaEvents)) knownEvents.add(event);
  const fixtures = catalog(spec.simulationFixtureCatalog, "simulation-fixtures-invalid");
  const simulations = objectArray(spec.seededSimulations, "simulations-invalid");
  const simulationIds = idsFromObjects(simulations, "simulation");
  const simulationById = new Map(simulations.map((simulation) => [simulation.id as string, simulation]));

  for (const simulation of simulations) {
    const initial = objectValue(simulation.initialRecords, "simulation-initial-invalid");
    if (typeof initial.fixture !== "string" || !(initial.fixture in fixtures)) fail("simulation-fixture-unresolved");
    const fixture = fixtures[initial.fixture];
    if (initial.fixtureSpecHash !== fixture.fixtureSpecHash) fail("simulation-fixture-stale");
    const events = objectArray(simulation.events, "simulation-events-invalid");
    if (events.length === 0) fail("simulation-events-empty");
    for (const event of events) {
      if (typeof event.event !== "string" || !knownEvents.has(event.event)) fail("simulation-event-unresolved");
    }
    const assertions = objectArray(simulation.assertions, "simulation-assertions-invalid");
    if (assertions.length === 0) fail("simulation-assertions-empty");
    for (const assertion of assertions) {
      if (typeof assertion.op !== "string" || !registeredSet.has(assertion.op)) fail("simulation-assertion-operator-unresolved");
    }
    const expected = objectValue(simulation.expected, "simulation-expected-invalid");
    if (typeof expected.terminal !== "string" || expected.terminal.length === 0) fail("simulation-terminal-missing");
    if (simulation.id !== "complete-positive-replay" && expected.terminal === "CLOSED") {
      fail("false-terminal-closure");
    }
  }
  for (const id of REQUIRED_NEGATIVE_SIMULATIONS) {
    const simulation = simulationById.get(id);
    if (!simulation) fail("required-negative-simulation-missing");
    const expected = objectValue(simulation.expected, "simulation-expected-invalid");
    if (expected.terminal === "CLOSED") fail("negative-simulation-closed");
  }
  const positive = simulationById.get("complete-positive-replay");
  if (!positive) fail("positive-simulation-missing");
  if (
    !sameJson(positive.events, [{ event: "REPLAY_ALL_VALID_PACKET_AND_GATE_EVENTS_IN_TOPOLOGICAL_ORDER" }]) ||
    !sameJson(positive.expected, { terminal: "CLOSED", closedTransitionCount: 1 })
  ) {
    fail("positive-replay-outcome-invalid");
  }
  const closedCount = simulations.filter((simulation) => objectValue(simulation.expected, "simulation-expected-invalid").terminal === "CLOSED").length;
  if (closedCount !== 1) fail("simulation-closed-outcome-not-sole");

  const replayProjection = simulations
    .map((simulation) => {
      const initial = objectValue(simulation.initialRecords, "simulation-initial-invalid");
      const expected = objectValue(simulation.expected, "simulation-expected-invalid");
      return {
        id: simulation.id,
        fixture: initial.fixture,
        fixtureSpecHash: initial.fixtureSpecHash,
        events: objectArray(simulation.events, "simulation-events-invalid").map((event) => event.event),
        terminal: expected.terminal,
        assertions: objectArray(simulation.assertions, "simulation-assertions-invalid").map((assertion) => assertion.op),
      };
    })
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return {
    operatorCount: registered.length,
    simulationCount: simulationIds.length,
    simulationReplayHash: createHash("sha256").update(JSON.stringify(replayProjection)).digest("hex"),
  };
}

export interface LoopSpecValidationSummary {
  schemaVersion: "breadboard.loop-spec-validation.v1";
  frozenSpecSha256: string;
  frozenSpecSchema: string;
  packetCount: number;
  gateCount: number;
  artifactCount: number;
  acceptanceCount: number;
  operatorCount: number;
  simulationCount: number;
  simulationReplayHash: string;
  status: "pass";
}

export function validateLoopSpecDocument(spec: unknown): LoopSpecValidationSummary {
  const document = objectValue(spec, "spec-document-invalid");
  assertClosedTopLevel(document);
  const counts = validateOwnershipAndReferences(document);
  validateGraph(document);
  validateTransitionsAndClosure(document);
  validateJsonSchemas(document);
  validateCommandSafety(document);
  const predicateCounts = validatePredicatesAndSimulations(document);
  return {
    schemaVersion: "breadboard.loop-spec-validation.v1",
    frozenSpecSha256: FROZEN_SPEC_SHA256,
    frozenSpecSchema: FROZEN_SPEC_SCHEMA,
    ...counts,
    ...predicateCounts,
    status: "pass",
  };
}

export function loadAndValidateFrozenLoopSpec(path = FIXTURE_PATH): LoopSpecValidationSummary {
  const bytes = readFileSync(path);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== FROZEN_SPEC_SHA256) fail("frozen-spec-digest-mismatch");
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("frozen-spec-json-invalid");
  }
  return validateLoopSpecDocument(document);
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(loadAndValidateFrozenLoopSpec()));
  } catch (error) {
    const violation = error instanceof LoopSpecViolation ? error : new LoopSpecViolation("loop-spec-validation-failed");
    console.error(JSON.stringify({ schemaVersion: "breadboard.control-error.v1", code: violation.code }));
    process.exit(1);
  }
}
