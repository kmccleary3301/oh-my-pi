import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { ImportViolation, scanSourceText, verifyImports } from "./import-verifier.ts";
import {
  FROZEN_SPEC_SCHEMA,
  FROZEN_SPEC_SHA256,
  loadAndValidateFrozenLoopSpec,
  LoopSpecViolation,
  validateLoopSpecDocument,
} from "./loop-spec-validator.ts";
import {
  predicateBindingHash,
  predicateRecordHash,
  PredicateEngine,
} from "./predicate-engine.ts";
import type { ArtifactEvidenceState, JsonObject, PredicateRecord } from "./predicate-engine.ts";
import {
  ControlViolation,
  validateDonorTagListing,
  validateDonorPin,
  validateExclusions,
  validateOwnership,
  verifySourceProvenance,
} from "./source-verifier.ts";
import type { ExclusionManifest } from "./source-verifier.ts";

const ROOT = resolve(import.meta.dir, "../..");
const FIXTURE = resolve(import.meta.dir, "fixtures/BB_TUI_P29_BB_OMP_TOTAL_FULFILLMENT_PR_DAG.json");
const ORACLE_OBJECT = "3047c27c332c5629c8e063283d349384c10c9a56";
const LICENSE_SHA256 = "545636e19386d3d4e0ae6d77354527499999c3ebfbca61b9fa5aa4ead7c0b308";

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function objectValue(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("test-object-required");
  return value as JsonObject;
}

function arrayValue(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("test-array-required");
  return value;
}

function propertyObject(value: JsonObject, key: string): JsonObject {
  return objectValue(value[key]);
}

function expectControlCode(action: () => void, code: string): void {
  try {
    action();
    throw new Error("expected-control-violation");
  } catch (error) {
    expect(error).toBeInstanceOf(ControlViolation);
    if (error instanceof ControlViolation) expect(error.code).toBe(code);
  }
}

function expectImportCode(action: () => void, code: string): void {
  try {
    action();
    throw new Error("expected-import-violation");
  } catch (error) {
    expect(error).toBeInstanceOf(ImportViolation);
    if (error instanceof ImportViolation) expect(error.code).toBe(code);
  }
}

function frozenDocument(): JsonObject {
  const value = readJson(FIXTURE);
  validateLoopSpecDocument(value);
  return objectValue(value);
}

function exclusions(): ExclusionManifest {
  const value = readJson(resolve(import.meta.dir, "source-exclusions.json"));
  validateExclusions(value);
  return value;
}

function passingArtifact(): ArtifactEvidenceState {
  return {
    outerVerdict: "pass",
    supportLevel: "confirmed",
    payload: {
      commandId: "focused-test",
      commandSha256: "a".repeat(64),
      exitCode: 0,
      contractAssertionSetHash: "b".repeat(64),
      assertionResults: [
        {
          assertionId: "A1.focused",
          passed: true,
          observedDigest: "c".repeat(64),
        },
      ],
      testOutputPolicyHash: "0110e29aacdc718f93354c95c87d4b27b65c3e024f7b59b05b7414c029b9f752",
      outputDisposition: "no-output-produced",
      outputQuarantineAttestationHash: "d".repeat(64),
    },
    current: true,
  };
}

function predicateRecord(
  predicate: JsonObject,
  matches: boolean,
  current = true,
): PredicateRecord {
  const predicateHash = predicateBindingHash(predicate);
  const sourceRecordHash = "a".repeat(64);
  const actual = { observed: matches ? "expected" : "different" };
  const expected = { observed: "expected" };
  return {
    predicateHash,
    sourceRecordHash,
    current,
    actual,
    expected,
    recordHash: predicateRecordHash(predicateHash, sourceRecordHash, current, actual, expected),
  };
}

function predicateRecords(
  entries: ReadonlyArray<readonly [JsonObject, boolean]>,
): Record<string, PredicateRecord> {
  return Object.fromEntries(
    entries.map(([predicate, matches]) => [
      predicateBindingHash(predicate),
      predicateRecord(predicate, matches),
    ]),
  );
}

function collectPredicates(value: unknown, predicates: Map<string, JsonObject>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectPredicates(entry, predicates);
    return;
  }
  if (!value || typeof value !== "object") return;
  const object = objectValue(value);
  if (typeof object.op === "string" && !predicates.has(object.op)) predicates.set(object.op, object);
  for (const entry of Object.values(object)) collectPredicates(entry, predicates);
}

function collectRequiredRecordOutcomes(
  predicate: JsonObject,
  desired: boolean,
  spec: JsonObject,
  outcomes: Array<readonly [JsonObject, boolean]>,
): void {
  if (predicate.op === "and") {
    const argumentsToEvaluate = arrayValue(predicate.args).map(objectValue);
    if (desired) {
      for (const argument of argumentsToEvaluate) {
        collectRequiredRecordOutcomes(argument, true, spec, outcomes);
      }
    } else {
      collectRequiredRecordOutcomes(argumentsToEvaluate[0], false, spec, outcomes);
    }
    return;
  }
  if (predicate.op === "not") {
    collectRequiredRecordOutcomes(propertyObject(predicate, "arg"), !desired, spec, outcomes);
    return;
  }
  if (predicate.op === "evaluateCanonicalCloseoutPredicate") {
    collectRequiredRecordOutcomes(propertyObject(spec, "closeoutPredicate"), desired, spec, outcomes);
    return;
  }
  if (predicate.op === "true") {
    if (!desired) throw new Error("true predicate cannot produce false");
    return;
  }
  if (predicate.op === "artifactSupportsAcceptance") {
    throw new Error("artifact predicate requires artifact payload fixture");
  }
  outcomes.push([predicate, desired]);
}

describe("pinned provenance and source inventory", () => {
  test("binds the exact donor, base, notices, and changed-path inventory", () => {
    const first = verifySourceProvenance(ROOT);
    const second = verifySourceProvenance(ROOT);

    expect(first).toEqual(second);
    expect(first.status).toBe("pass");
    expect(first.oracleObject).toBe(ORACLE_OBJECT);
    expect(first.donorTagObject).toBe(ORACLE_OBJECT);
    expect(first.controlStage).toBe("A1");
    expect(first.changedPathCount).toBe(13);
    expect(first.ownedPathCount).toBe(13);
    expect(first.changedPathCount).toBe(first.ownedPathCount);
    for (const digest of [
      first.changedPathClassificationHash,
      first.donorPinSha256,
      first.ownershipManifestSha256,
      first.exclusionManifestSha256,
      first.noticeSha256,
      first.thirdPartyNoticeSha256,
      first.provenanceBindingHash,
    ]) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(createHash("sha256").update(readFileSync(resolve(ROOT, "LICENSE"))).digest("hex")).toBe(LICENSE_SHA256);
  });

  test("rejects donor drift and missing provenance fields", () => {
    const donor = objectValue(readJson(resolve(import.meta.dir, "donor-pin.json")));
    validateDonorPin(donor);

    const drifted = structuredClone(donor);
    propertyObject(drifted, "donor").gitObject = "0000000000000000000000000000000000000000";
    expectControlCode(() => validateDonorPin(drifted), "donor-pin-drift");

    const missing = structuredClone(donor);
    delete propertyObject(missing, "donor").origin;
    expectControlCode(() => validateDonorPin(missing), "donor-detail-open");
    expect(validateDonorTagListing(`${ORACLE_OBJECT}\trefs/tags/v16.5.0\n`)).toBe(ORACLE_OBJECT);
    expectControlCode(
      () => validateDonorTagListing(`${"0".repeat(40)}\trefs/tags/v16.5.0\n`),
      "donor-tag-object-drift",
    );
  });

  test("rejects unsafe exclusion drift, ownership collisions, and changed paths", () => {
    const exclusionManifest = exclusions();
    const unsafeExclusions = structuredClone(exclusionManifest);
    unsafeExclusions.forbiddenImportPathSegments = unsafeExclusions.forbiddenImportPathSegments.filter(
      (segment) => segment !== "vendor",
    );
    expectControlCode(() => validateExclusions(unsafeExclusions), "forbidden-island-scope-drift");

    const ownershipValue = readJson(resolve(import.meta.dir, "ownership-manifest.json"));
    validateOwnership(ownershipValue, undefined, "A1", ROOT);

    const collision = structuredClone(ownershipValue);
    const collisionObject = objectValue(collision);
    collisionObject.ownedPaths = [...arrayValue(collisionObject.ownedPaths), "notice.md"];
    expectControlCode(() => validateOwnership(collision, undefined, "A1", ROOT), "owned-path-collision");

    const changed = structuredClone(ownershipValue);
    validateOwnership(changed);
    expectControlCode(
      () => validateOwnership(changed, [...changed.ownedPaths, "packages/not-allowed/index.ts"], "A1", ROOT),
      "changed-path-outside-allowlist",
    );
  });
});

describe("source and import exclusion controls", () => {
  test("classifies allowed static and dynamic edges deterministically", () => {
    const findings = scanSourceText(
      "scripts/breadboard-controls/example.ts",
      [
        'import value from "node:fs";',
        'export { value } from "./safe-module.ts";',
        'import legacy = require("legacy-package");',
        'const required = require("safe-package");',
        'const loaded = import("./safe-dynamic.ts");',
        'type Imported = import("safe-types").Imported;',
      ].join("\n"),
      exclusions(),
    );

    expect(findings.map((finding) => finding.kind)).toEqual([
      "static-import",
      "static-export",
      "import-equals",
      "require",
      "dynamic-import",
      "import-type",
    ]);
    expect(findings.filter((finding) => finding.classification === "bare")).toHaveLength(4);
    expect(findings.filter((finding) => finding.classification === "local")).toHaveLength(2);
  });

  test("rejects excluded packages and vendor, generated, and patch islands", () => {
    const manifest = exclusions();
    expectImportCode(
      () => scanSourceText("scripts/breadboard-controls/example.ts", 'import "packages/breadboard-app/runtime";', manifest),
      "forbidden-import-island",
    );
    for (const island of ["vendor", "vendored", "generated", "patches"]) {
      expectImportCode(
        () => scanSourceText("scripts/breadboard-controls/example.ts", `import "./${island}/unsafe.ts";`, manifest),
        "forbidden-import-island",
      );
    }
  });

  test("rejects nonliteral imports and reports a stable repository summary", () => {
    expectImportCode(
      () => scanSourceText("scripts/breadboard-controls/example.ts", "const name = './module.ts'; import(name);", exclusions()),
      "module-specifier-nonliteral",
    );
    const first = verifyImports(ROOT);
    const second = verifyImports(ROOT);
    expect(first).toEqual(second);
    expect(first.status).toBe("pass");
    expect(first.sourceFileCount).toBe(5);
    expect(first.classifiedPathHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("frozen DAG machine validation", () => {
  test("validates the exact frozen document and deterministic replay projection", () => {
    const first = loadAndValidateFrozenLoopSpec();
    const second = loadAndValidateFrozenLoopSpec();

    expect(first).toEqual(second);
    expect(first.status).toBe("pass");
    expect(first.frozenSpecSha256).toBe(FROZEN_SPEC_SHA256);
    expect(first.frozenSpecSchema).toBe(FROZEN_SPEC_SCHEMA);
    expect(first.packetCount).toBe(72);
    expect(first.operatorCount).toBe(360);
    expect(first.simulationCount).toBe(90);
    expect(first.simulationReplayHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects frozen-byte hash drift without modifying the source fixture", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "breadboard-a1-"));
    const mutatedPath = join(temporaryDirectory, "mutated.json");
    try {
      writeFileSync(mutatedPath, `${readFileSync(FIXTURE, "utf8")}\n`);
      expect(() => loadAndValidateFrozenLoopSpec(mutatedPath)).toThrow(
        new LoopSpecViolation("frozen-spec-digest-mismatch"),
      );
      expect(createHash("sha256").update(readFileSync(FIXTURE)).digest("hex")).toBe(FROZEN_SPEC_SHA256);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  test("rejects oracle drift, empty required records, and dependency cycles", () => {
    const oracleDrift = structuredClone(frozenDocument());
    propertyObject(oracleDrift, "sourcePins").ompReleaseCommit = "0000000000000000000000000000000000000000";
    expect(() => validateLoopSpecDocument(oracleDrift)).toThrow(new LoopSpecViolation("oracle-pin-drift"));

    const emptyRecord = structuredClone(frozenDocument());
    const externalArtifacts = propertyObject(emptyRecord, "externalArtifacts");
    propertyObject(externalArtifacts, "external.plan-review.loop").requiredFields = [];
    expect(() => validateLoopSpecDocument(emptyRecord)).toThrow(
      new LoopSpecViolation("external-artifact-required-fields-empty"),
    );

    const cycle = structuredClone(frozenDocument());
    const packets = arrayValue(cycle.packets).map(objectValue);
    const packetA1 = packets.find((packet) => packet.id === "A1");
    if (!packetA1) throw new Error("A1 fixture missing");
    packetA1.dependsOnPackets = [...arrayValue(packetA1.dependsOnPackets), "G16"];
    expect(() => validateLoopSpecDocument(cycle)).toThrow(new LoopSpecViolation("expanded-dependency-cycle"));
  });
  test("replays all seeded records and rejects outcome transcript divergence", () => {
    const driftedReplay = structuredClone(frozenDocument());
    const simulations = arrayValue(driftedReplay.seededSimulations).map(objectValue);
    const firstExpected = propertyObject(simulations[0], "expected");
    firstExpected.terminal = "OWNER_DECISION";
    expect(() => validateLoopSpecDocument(driftedReplay)).toThrow(
      new LoopSpecViolation("simulation-replay-divergence"),
    );
  });

});

describe("predicate-engine conformance", () => {
  test("evaluates A1 artifact acceptance and rejects stale or empty evidence", () => {
    const document = frozenDocument();
    const acceptances = propertyObject(document, "acceptanceCatalog");
    const acceptance = propertyObject(propertyObject(acceptances, "A1.accept.focused-test"), "predicate");
    const engine = new PredicateEngine(document);
    const payloadDefinitions = propertyObject(document, "evidencePayloadSchemas");
    const testReportDefinition = propertyObject(payloadDefinitions, "TestReportEvidence");
    const semanticPredicates = arrayValue(testReportDefinition.semanticPredicates).map(objectValue);
    const semanticRecords = predicateRecords(
      semanticPredicates.map((predicate) => [predicate, true] as const),
    );

    expect(
      engine.evaluate(acceptance, {
        artifacts: { "A1.focused-test": passingArtifact() },
        records: semanticRecords,
      }),
    ).toEqual({
      value: true,
      errors: [],
      evaluatedOperatorCount: semanticPredicates.length + 1,
    });

    const stale = passingArtifact();
    stale.current = false;
    expect(engine.evaluate(acceptance, { artifacts: { "A1.focused-test": stale } })).toMatchObject({
      value: false,
      errors: ["evidence-stale"],
    });

    const emptyAssertionResults = passingArtifact();
    emptyAssertionResults.payload.assertionResults = [];
    expect(
      engine.evaluate(acceptance, {
        artifacts: { "A1.focused-test": emptyAssertionResults },
        records: semanticRecords,
      }),
    ).toMatchObject({
      value: false,
      errors: ["evidence-schema-invalid"],
    });
  });

  test("evaluates A1 changed-path and CI predicates against immutable records", () => {
    const document = frozenDocument();
    const acceptances = propertyObject(document, "acceptanceCatalog");
    const engine = new PredicateEngine(document);
    const changedPaths = propertyObject(propertyObject(acceptances, "A1.accept.changed-paths"), "predicate");
    const ciMerge = propertyObject(propertyObject(acceptances, "A1.accept.ci-merge"), "predicate");

    expect(engine.evaluate(changedPaths, { records: predicateRecords([[changedPaths, true]]) }).value).toBe(true);
    expect(engine.evaluate(changedPaths, { records: predicateRecords([[changedPaths, false]]) }).value).toBe(false);
    const ciArguments = arrayValue(ciMerge.args).map(objectValue);
    expect(
      engine.evaluate(ciMerge, { records: predicateRecords(ciArguments.map((predicate) => [predicate, true] as const)) }).value,
    ).toBe(true);
    expect(
      engine.evaluate(ciMerge, { records: predicateRecords([
        [ciArguments[0], true],
        [ciArguments[1], false],
      ]) }).value,
    ).toBe(false);
  });

  test("binds every generic operator result to the exact predicate and source record", () => {
    const document = frozenDocument();
    const engine = new PredicateEngine(document);
    const predicates = new Map<string, JsonObject>();
    collectPredicates(document, predicates);
    const registered = arrayValue(propertyObject(document, "predicateEngine").registeredOperators);
    const specialOperators: Record<string, true> = {
      and: true,
      artifactSupportsAcceptance: true,
      evaluateCanonicalCloseoutPredicate: true,
      not: true,
      true: true,
    };
    let checked = 0;
    for (const operator of registered) {
      if (typeof operator !== "string" || specialOperators[operator]) continue;
      const predicate = predicates.get(operator);
      if (!predicate) throw new Error(`registered predicate missing: ${operator}`);
      expect(engine.evaluate(predicate, { records: predicateRecords([[predicate, true]]) })).toMatchObject({
        value: true,
        errors: [],
      });
      expect(engine.evaluate(predicate, { records: predicateRecords([[predicate, false]]) })).toMatchObject({
        value: false,
        errors: [],
      });
      checked += 1;
    }
    expect(checked).toBe(355);

    const changedPathA1 = propertyObject(
      propertyObject(propertyObject(document, "acceptanceCatalog"), "A1.accept.changed-paths"),
      "predicate",
    );
    const changedPathOther = structuredClone(changedPathA1);
    changedPathOther.packetId = "A2";
    expect(
      engine.evaluate(changedPathOther, { records: predicateRecords([[changedPathA1, true]]) }),
    ).toMatchObject({ value: false, errors: ["predicate-record-missing"] });

    const tamperedRecords = predicateRecords([[changedPathA1, true]]);
    tamperedRecords[predicateBindingHash(changedPathA1)].actual = { observed: "different" };
    expect(engine.evaluate(changedPathA1, { records: tamperedRecords })).toMatchObject({
      value: false,
      errors: ["predicate-record-binding-invalid"],
    });
  });

  test("executes boolean and canonical-closeout operator families", () => {
    const document = frozenDocument();
    const engine = new PredicateEngine(document);
    const predicates = new Map<string, JsonObject>();
    collectPredicates(document, predicates);

    const truePredicate = predicates.get("true");
    const notPredicate = predicates.get("not");
    const canonicalPredicate = predicates.get("evaluateCanonicalCloseoutPredicate");
    if (!truePredicate || !notPredicate || !canonicalPredicate) {
      throw new Error("special predicate fixture missing");
    }
    expect(engine.evaluate(truePredicate)).toMatchObject({ value: true, errors: [] });
    expect(engine.evaluate({ ...truePredicate, unexpected: true })).toMatchObject({
      value: false,
      errors: ["predicate-schema-violation"],
    });

    const notTrueOutcomes: Array<readonly [JsonObject, boolean]> = [];
    collectRequiredRecordOutcomes(notPredicate, true, document, notTrueOutcomes);
    expect(engine.evaluate(notPredicate, { records: predicateRecords(notTrueOutcomes) })).toMatchObject({
      value: true,
      errors: [],
    });
    const notFalseOutcomes: Array<readonly [JsonObject, boolean]> = [];
    collectRequiredRecordOutcomes(notPredicate, false, document, notFalseOutcomes);
    expect(engine.evaluate(notPredicate, { records: predicateRecords(notFalseOutcomes) })).toMatchObject({
      value: false,
      errors: [],
    });

    const closeoutOutcomes: Array<readonly [JsonObject, boolean]> = [];
    collectRequiredRecordOutcomes(canonicalPredicate, true, document, closeoutOutcomes);
    expect(
      engine.evaluate(canonicalPredicate, { records: predicateRecords(closeoutOutcomes) }),
    ).toMatchObject({ value: true, errors: [] });
    const deniedCloseout = closeoutOutcomes.map(([predicate, matches], index) =>
      [predicate, index === 0 ? !matches : matches] as const
    );
    expect(
      engine.evaluate(canonicalPredicate, { records: predicateRecords(deniedCloseout) }),
    ).toMatchObject({ value: false, errors: [] });
  });

  test("fails closed for unknown, malformed, and incomplete predicates", () => {
    const engine = new PredicateEngine(frozenDocument());
    expect(engine.evaluate({ op: "unregisteredPredicate" })).toEqual({
      value: false,
      errors: ["predicate-operator-unknown"],
      evaluatedOperatorCount: 0,
    });
    expect(engine.evaluate({ op: "and", args: [] })).toMatchObject({
      value: false,
      errors: ["predicate-required-collection-empty"],
    });
    expect(engine.evaluate({ op: "changedPathProofValid" })).toMatchObject({
      value: false,
      errors: ["predicate-schema-violation"],
    });
  });
});
