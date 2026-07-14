import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ORACLE_BASE = "3047c27c332c5629c8e063283d349384c10c9a56";
const OMP_ORIGIN = "https://github.com/can1357/oh-my-pi";
const OMP_TAG = "v16.5.0";
const OMP_LICENSE_SHA256 = "545636e19386d3d4e0ae6d77354527499999c3ebfbca61b9fa5aa4ead7c0b308";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const EXPECTED_ALLOWLIST = [
  "NOTICE.md",
  "THIRD_PARTY_NOTICES/**",
  ".github/workflows/**",
  "scripts/**",
  "package.json",
  "bun.lock",
] as const;

const EXPECTED_A1_OWNED_PATHS = [
  ".github/workflows/breadboard-controls.yml",
  "NOTICE.md",
  "THIRD_PARTY_NOTICES/oh-my-pi-v16.5.0.md",
  "package.json",
  "scripts/breadboard-controls/controls.test.ts",
  "scripts/breadboard-controls/donor-pin.json",
  "scripts/breadboard-controls/fixtures/BB_TUI_P29_BB_OMP_TOTAL_FULFILLMENT_PR_DAG.json",
  "scripts/breadboard-controls/import-verifier.ts",
  "scripts/breadboard-controls/loop-spec-validator.ts",
  "scripts/breadboard-controls/ownership-manifest.json",
  "scripts/breadboard-controls/predicate-engine.ts",
  "scripts/breadboard-controls/source-exclusions.json",
  "scripts/breadboard-controls/source-verifier.ts",
] as const;

const EXPECTED_DONOR_KEYS = [
  "baselineRole",
  "breadboardAuthorshipScope",
  "donor",
  "schemaVersion",
];
const EXPECTED_DONOR_DETAIL_KEYS = [
  "gitObject",
  "gitObjectFormat",
  "license",
  "licenseSha256",
  "licenseSourcePath",
  "name",
  "origin",
  "releaseTag",
];
const EXPECTED_OWNERSHIP_KEYS = [
  "allowlist",
  "controlStageField",
  "oracleBase",
  "oracleBaselineRole",
  "ownedPaths",
  "schemaVersion",
  "stagePolicies",
];
const EXPECTED_EXCLUSION_KEYS = [
  "classification",
  "controlStageField",
  "forbiddenImportPathSegments",
  "nonSourceFixturePrefixes",
  "schemaVersion",
  "stageForbiddenImportSpecifierPrefixes",
  "stageForbiddenSourcePrefixes",
];
const EXPECTED_STAGE_POLICY_KEYS = [
  "additiveOwnedPatterns",
  "forbiddenPackageRoots",
  "requiredChangedPrefixes",
];
const EXPECTED_CLASSIFICATION_KEYS = [
  "breadboardOwned",
  "excludedFromBreadboardAuthorship",
  "oracleCopiedBaseline",
];

export class ControlViolation extends Error {
  constructor(readonly code: string, readonly pathClass?: string) {
    super(pathClass ? `${code}:${pathClass}` : code);
    this.name = "ControlViolation";
  }
}

interface DonorPin {
  schemaVersion: string;
  donor: {
    name: string;
    origin: string;
    releaseTag: string;
    gitObject: string;
    gitObjectFormat: string;
    license: string;
    licenseSourcePath: string;
    licenseSha256: string;
  };
  baselineRole: string;
  breadboardAuthorshipScope: string;
}

interface StagePolicy {
  additiveOwnedPatterns: string[];
  requiredChangedPrefixes: string[];
  forbiddenPackageRoots: string[];
}

export interface OwnershipManifest {
  schemaVersion: string;
  oracleBase: string;
  oracleBaselineRole: string;
  controlStageField: string;
  allowlist: string[];
  ownedPaths: string[];
  stagePolicies: Record<string, StagePolicy>;
}

export interface ExclusionManifest {
  schemaVersion: string;
  classification: Record<string, string>;
  controlStageField: string;
  stageForbiddenSourcePrefixes: Record<string, string[]>;
  forbiddenImportPathSegments: string[];
  stageForbiddenImportSpecifierPrefixes: Record<string, string[]>;
  nonSourceFixturePrefixes: string[];
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function exactKeys(value: unknown, expected: readonly string[], code: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlViolation(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ControlViolation(code);
  }
}

function uniqueStrings(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new ControlViolation(code);
  if (new Set(value).size !== value.length) throw new ControlViolation(`${code}-duplicate`);
  return value;
}

function normalizeRepositoryPath(path: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new ControlViolation("path-not-normalized", "invalid-root");
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ControlViolation("path-not-normalized", "invalid-segment");
  }
  return parts.join("/");
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === pattern;
}

function isAtOrBelow(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function sameStringSet(actual: readonly string[], expected: readonly string[]): boolean {
  const left = [...actual].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertNoPortablePathCollisions(paths: readonly string[], code: string): void {
  const seen = new Set<string>();
  for (const path of paths) {
    const collisionKey = path.normalize("NFC").toLowerCase();
    if (seen.has(collisionKey)) throw new ControlViolation(code);
    seen.add(collisionKey);
  }
}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new ControlViolation("manifest-json-invalid", relative(ROOT, path).split(sep).join("/"));
  }
}

function git(args: string[], code: string, root = ROOT): Uint8Array {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "" },
  });
  if (result.exitCode !== 0) throw new ControlViolation(code);
  return result.stdout;
}

export function validateDonorTagListing(listing: string): string {
  const expectedRef = `refs/tags/${OMP_TAG}`;
  const records = listing.trimEnd().split("\n");
  if (records.length !== 1) throw new ControlViolation("donor-tag-listing-invalid");
  const fields = records[0].split("\t");
  if (fields.length !== 2 || fields[0] !== ORACLE_BASE || fields[1] !== expectedRef) {
    throw new ControlViolation("donor-tag-object-drift");
  }
  return fields[0];
}

let verifiedDonorTagObject: string | undefined;

function verifyDonorTagBinding(root: string): string {
  if (verifiedDonorTagObject) return verifiedDonorTagObject;
  const result = Bun.spawnSync(
    ["git", "ls-remote", "--exit-code", "--refs", OMP_ORIGIN, `refs/tags/${OMP_TAG}`],
    {
      cwd: root,
      stdout: "pipe",
      stderr: "ignore",
      timeout: 15_000,
      env: {
        GIT_TERMINAL_PROMPT: "0",
        PATH: process.env.PATH ?? "",
      },
    },
  );
  if (result.exitCode !== 0) throw new ControlViolation("donor-tag-lookup-failed");
  verifiedDonorTagObject = validateDonorTagListing(Buffer.from(result.stdout).toString("utf8"));
  return verifiedDonorTagObject;
}

function decodeNul(data: Uint8Array): string[] {
  const text = Buffer.from(data).toString("utf8");
  if (text.length === 0) return [];
  const records = text.split("\0");
  if (records.at(-1) === "") records.pop();
  return records;
}

export function validateDonorPin(pin: unknown): asserts pin is DonorPin {
  exactKeys(pin, EXPECTED_DONOR_KEYS, "donor-manifest-open");
  exactKeys(pin.donor, EXPECTED_DONOR_DETAIL_KEYS, "donor-detail-open");
  const donor = pin.donor as unknown as DonorPin["donor"];
  if (
    pin.schemaVersion !== "breadboard.donor-pin.v1" ||
    pin.baselineRole !== "oracle-copied" ||
    pin.breadboardAuthorshipScope !== "owned-control-paths-only" ||
    donor.name !== "Oh My Pi" ||
    donor.origin !== OMP_ORIGIN ||
    donor.releaseTag !== OMP_TAG ||
    donor.gitObject !== ORACLE_BASE ||
    donor.gitObjectFormat !== "sha1" ||
    donor.license !== "MIT" ||
    donor.licenseSourcePath !== "LICENSE" ||
    donor.licenseSha256 !== OMP_LICENSE_SHA256
  ) {
    throw new ControlViolation("donor-pin-drift");
  }
}

export function validateExclusions(value: unknown): asserts value is ExclusionManifest {
  exactKeys(value, EXPECTED_EXCLUSION_KEYS, "exclusion-manifest-open");
  exactKeys(value.classification, EXPECTED_CLASSIFICATION_KEYS, "classification-open");
  const manifest = value as unknown as ExclusionManifest;
  if (
    manifest.schemaVersion !== "breadboard.source-exclusions.v1" ||
    manifest.controlStageField !== "breadboardControls.stage"
  ) {
    throw new ControlViolation("exclusion-schema-drift");
  }
  const stageSourceRequirements: Record<string, string[]> = {
    A1: ["packages/breadboard-adapters", "packages/breadboard-app"],
    A2: ["packages/breadboard-app"],
    A3: [],
  };
  const stageImportRequirements: Record<string, string[]> = {
    A1: ["packages/breadboard-adapters", "packages/breadboard-app"],
    A2: ["packages/breadboard-app"],
    A3: [],
  };
  for (const [stage, required] of Object.entries(stageSourceRequirements)) {
    const sourceEntries = uniqueStrings(manifest.stageForbiddenSourcePrefixes?.[stage], `exclusion-source-${stage}`);
    const importEntries = uniqueStrings(
      manifest.stageForbiddenImportSpecifierPrefixes?.[stage],
      `exclusion-import-${stage}`,
    );
    for (const entry of [...sourceEntries, ...importEntries]) normalizeRepositoryPath(entry);
    if (!sameStringSet(sourceEntries, required) || !sameStringSet(importEntries, stageImportRequirements[stage])) {
      throw new ControlViolation("forbidden-source-scope-drift");
    }
  }
  if (
    manifest.classification.oracleCopiedBaseline !==
      "every tracked oracle path not classified by the active ownership stage" ||
    manifest.classification.breadboardOwned !== "ownedPaths plus active stage additiveOwnedPatterns" ||
    manifest.classification.excludedFromBreadboardAuthorship !== "all oracleCopiedBaseline paths"
  ) {
    throw new ControlViolation("classification-drift");
  }
  if (
    !sameStringSet(Object.keys(manifest.stageForbiddenSourcePrefixes), ["A1", "A2", "A3"]) ||
    !sameStringSet(Object.keys(manifest.stageForbiddenImportSpecifierPrefixes), ["A1", "A2", "A3"])
  ) {
    throw new ControlViolation("exclusion-stage-open");
  }
  const fixturePrefixes = uniqueStrings(manifest.nonSourceFixturePrefixes, "non-source-fixtures");
  fixturePrefixes.forEach(normalizeRepositoryPath);
  if (!sameStringSet(fixturePrefixes, ["scripts/breadboard-controls/fixtures"])) {
    throw new ControlViolation("non-source-fixture-scope-drift");
  }
  const forbiddenSegments = uniqueStrings(manifest.forbiddenImportPathSegments, "forbidden-import-segments");
  if (!sameStringSet(forbiddenSegments, ["generated", "patches", "vendor", "vendored"])) {
    throw new ControlViolation("forbidden-island-scope-drift", "import-segment");
  }
}

export function validateOwnership(
  value: unknown,
  changedPaths?: readonly string[],
  stage = "A1",
  root = ROOT,
): asserts value is OwnershipManifest {
  exactKeys(value, EXPECTED_OWNERSHIP_KEYS, "ownership-manifest-open");
  const manifest = value as unknown as OwnershipManifest;
  if (
    manifest.schemaVersion !== "breadboard.ownership-manifest.v1" ||
    manifest.oracleBase !== ORACLE_BASE ||
    manifest.oracleBaselineRole !== "oracle-copied" ||
    manifest.controlStageField !== "breadboardControls.stage"
  ) {
    throw new ControlViolation("ownership-pin-drift");
  }
  const allowlist = uniqueStrings(manifest.allowlist, "allowlist");
  if (!sameStringSet(allowlist, EXPECTED_ALLOWLIST)) throw new ControlViolation("allowlist-drift");
  const owned = uniqueStrings(manifest.ownedPaths, "owned-paths").map(normalizeRepositoryPath);
  assertNoPortablePathCollisions(owned, "owned-path-collision");
  if (!sameStringSet(owned, EXPECTED_A1_OWNED_PATHS)) throw new ControlViolation("ownership-inventory-drift");
  const expectedPolicies: Record<string, StagePolicy> = {
    A1: {
      additiveOwnedPatterns: [],
      requiredChangedPrefixes: [],
      forbiddenPackageRoots: ["packages/breadboard-adapters", "packages/breadboard-app"],
    },
    A2: {
      additiveOwnedPatterns: ["bun.lock", "packages/breadboard-adapters/**"],
      requiredChangedPrefixes: ["packages/breadboard-adapters"],
      forbiddenPackageRoots: ["packages/breadboard-app"],
    },
    A3: {
      additiveOwnedPatterns: ["bun.lock", "packages/breadboard-adapters/**", "packages/breadboard-app/**"],
      requiredChangedPrefixes: ["packages/breadboard-adapters", "packages/breadboard-app"],
      forbiddenPackageRoots: [],
    },
  };
  if (!sameStringSet(Object.keys(manifest.stagePolicies), Object.keys(expectedPolicies))) {
    throw new ControlViolation("ownership-stage-open");
  }
  for (const [stageId, expected] of Object.entries(expectedPolicies)) {
    const policy = manifest.stagePolicies[stageId];
    exactKeys(policy, EXPECTED_STAGE_POLICY_KEYS, "ownership-stage-policy-open");
    for (const key of ["additiveOwnedPatterns", "requiredChangedPrefixes", "forbiddenPackageRoots"] as const) {
      const entries = uniqueStrings(policy[key], `ownership-stage-${key}`);
      for (const entry of entries) normalizeRepositoryPath(entry.endsWith("/**") ? entry.slice(0, -3) : entry);
      if (!sameStringSet(entries, expected[key])) throw new ControlViolation("ownership-stage-policy-drift");
    }
  }
  const policy = manifest.stagePolicies[stage];
  if (!policy) throw new ControlViolation("control-stage-unknown");
  for (const path of owned) {
    if (!allowlist.some((pattern) => pathMatches(pattern, path))) {
      throw new ControlViolation("owned-path-outside-allowlist", "owned");
    }
    if (expectedPolicies.A1.forbiddenPackageRoots.some((prefix) => isAtOrBelow(path, prefix))) {
      throw new ControlViolation("forbidden-owned-path", "forbidden-package");
    }
  }
  for (const path of owned) {
    const absolute = resolve(root, path);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) {
      throw new ControlViolation("owned-path-missing", "owned");
    }
  }
  if (changedPaths) {
    const normalizedChanged = changedPaths.map(normalizeRepositoryPath);
    for (const path of owned) {
      if (!normalizedChanged.includes(path)) throw new ControlViolation("ownership-inventory-missing");
    }
    for (const path of normalizedChanged) {
      if (!owned.includes(path) && !policy.additiveOwnedPatterns.some((pattern) => pathMatches(pattern, path))) {
        throw new ControlViolation(
          stage === "A1" ? "changed-path-outside-allowlist" : "changed-path-outside-stage-ownership",
          "changed",
        );
      }
    }
    for (const prefix of policy.requiredChangedPrefixes) {
      if (!normalizedChanged.some((path) => isAtOrBelow(path, prefix))) {
        throw new ControlViolation("stage-required-root-missing", "future-root-not-activated");
      }
    }
    if (stage === "A1" && !sameStringSet(owned, normalizedChanged)) {
      throw new ControlViolation("ownership-inventory-mismatch");
    }
  }
}

function collectChangedPaths(root: string): string[] {
  const tracked = decodeNul(git(["diff", "--name-only", "--no-renames", "-z", ORACLE_BASE, "--"], "git-diff-failed", root));
  const untracked = decodeNul(git(["ls-files", "--others", "--exclude-standard", "-z"], "git-untracked-failed", root));
  return [...new Set([...tracked, ...untracked].map(normalizeRepositoryPath))].sort();
}

function verifyRepositoryModes(root: string, changedPaths: readonly string[]): void {
  const indexEntries = decodeNul(git(["ls-files", "--stage", "-z"], "git-index-failed", root));
  for (const entry of indexEntries) {
    const tab = entry.indexOf("\t");
    const metadata = tab < 0 ? "" : entry.slice(0, tab);
    const mode = metadata.split(" ", 1)[0];
    if (mode !== "100644" && mode !== "100755") {
      throw new ControlViolation("tracked-mode-anomaly", mode === "160000" ? "submodule" : "symlink-or-special");
    }
  }
  for (const path of changedPaths) {
    const absolute = resolve(root, path);
    if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
      throw new ControlViolation("worktree-mode-anomaly", "symlink");
    }
  }
}

function verifyForbiddenPresence(root: string, exclusions: ExclusionManifest, stage: string): void {
  const forbidden = exclusions.stageForbiddenSourcePrefixes[stage];
  if (!forbidden) throw new ControlViolation("control-stage-unknown");
  for (const prefix of forbidden) {
    if (existsSync(resolve(root, prefix))) throw new ControlViolation("forbidden-source-present", "forbidden-package");
  }
}

function verifyPortableNotices(root: string): void {
  const notice = readFileSync(resolve(root, "NOTICE.md"), "utf8");
  const thirdParty = readFileSync(resolve(root, "THIRD_PARTY_NOTICES/oh-my-pi-v16.5.0.md"), "utf8");
  for (const required of [OMP_ORIGIN, OMP_TAG, ORACLE_BASE]) {
    if (!notice.includes(required) || !thirdParty.includes(required)) {
      throw new ControlViolation("notice-provenance-missing");
    }
  }
  const pinnedLicense = git(["show", `${ORACLE_BASE}:LICENSE`], "oracle-license-missing", root);
  if (sha256(pinnedLicense) !== OMP_LICENSE_SHA256) throw new ControlViolation("oracle-license-hash-drift");
  if (
    !thirdParty.includes(OMP_LICENSE_SHA256) ||
    !thirdParty.includes("MIT License") ||
    !thirdParty.endsWith(Buffer.from(pinnedLicense).toString("utf8"))
  ) {
    throw new ControlViolation("notice-license-missing");
  }
  if (!notice.includes("does not claim") || !thirdParty.includes("does not claim")) {
    throw new ControlViolation("notice-authorship-claim-unsafe");
  }
}

export interface SourceVerificationSummary {
  schemaVersion: "breadboard.source-verification.v1";
  controlStage: string;
  oracleObject: string;
  donorTagObject: string;
  oracleTree: string;
  changedPathCount: number;
  ownedPathCount: number;
  oracleCopiedPathCount: number;
  changedPathClassificationHash: string;
  donorPinSha256: string;
  ownershipManifestSha256: string;
  exclusionManifestSha256: string;
  noticeSha256: string;
  thirdPartyNoticeSha256: string;
  provenanceBindingHash: string;
  status: "pass";
}

export function verifySourceProvenance(root = ROOT): SourceVerificationSummary {
  git(["cat-file", "-e", `${ORACLE_BASE}^{commit}`], "oracle-object-missing", root);
  const oracleTree = Buffer.from(git(["rev-parse", `${ORACLE_BASE}^{tree}`], "oracle-tree-missing", root))
    .toString("utf8")
    .trim();
  if (!/^[0-9a-f]{40}$/.test(oracleTree)) throw new ControlViolation("oracle-tree-invalid");
  const donorTagObject = verifyDonorTagBinding(root);

  const donor = readJson<unknown>(resolve(root, "scripts/breadboard-controls/donor-pin.json"));
  const ownership = readJson<unknown>(resolve(root, "scripts/breadboard-controls/ownership-manifest.json"));
  const exclusions = readJson<unknown>(resolve(root, "scripts/breadboard-controls/source-exclusions.json"));
  const packageDocument = readJson<unknown>(resolve(root, "package.json"));
  if (
    !packageDocument ||
    typeof packageDocument !== "object" ||
    Array.isArray(packageDocument) ||
    !("breadboardControls" in packageDocument)
  ) {
    throw new ControlViolation("package-control-stage-missing");
  }
  exactKeys(packageDocument.breadboardControls, ["stage"], "package-control-stage-open");
  const stage = packageDocument.breadboardControls.stage;
  if (typeof stage !== "string") throw new ControlViolation("control-stage-invalid");
  validateDonorPin(donor);
  validateExclusions(exclusions);

  const changedPaths = collectChangedPaths(root);
  validateOwnership(ownership, changedPaths, stage, root);
  verifyRepositoryModes(root, changedPaths);
  verifyForbiddenPresence(root, exclusions, stage);
  verifyPortableNotices(root);

  const basePaths = decodeNul(git(["ls-tree", "-r", "--name-only", "-z", ORACLE_BASE], "oracle-tree-list-failed", root));
  const changedSet = new Set(changedPaths);
  const classifications = changedPaths.map((path) => `${path}\tBreadBoard-owned`).join("\n");
  const bindingPaths = [
    "NOTICE.md",
    "THIRD_PARTY_NOTICES/oh-my-pi-v16.5.0.md",
    "scripts/breadboard-controls/donor-pin.json",
    "scripts/breadboard-controls/ownership-manifest.json",
    "scripts/breadboard-controls/source-exclusions.json",
  ] as const;
  const bindingHashes = Object.fromEntries(
    bindingPaths.map((path) => [path, sha256(readFileSync(resolve(root, path)))]),
  );
  const bindingProjection = bindingPaths.map((path) => `${path}\0${bindingHashes[path]}`).join("\n");
  return {
    controlStage: stage,
    schemaVersion: "breadboard.source-verification.v1",
    oracleObject: ORACLE_BASE,
    donorTagObject,
    oracleTree,
    changedPathCount: changedPaths.length,
    ownedPathCount: ownership.ownedPaths.length,
    oracleCopiedPathCount: basePaths.filter((path) => !changedSet.has(path)).length,
    changedPathClassificationHash: sha256(classifications),
    donorPinSha256: bindingHashes["scripts/breadboard-controls/donor-pin.json"],
    ownershipManifestSha256: bindingHashes["scripts/breadboard-controls/ownership-manifest.json"],
    exclusionManifestSha256: bindingHashes["scripts/breadboard-controls/source-exclusions.json"],
    noticeSha256: bindingHashes["NOTICE.md"],
    thirdPartyNoticeSha256: bindingHashes["THIRD_PARTY_NOTICES/oh-my-pi-v16.5.0.md"],
    provenanceBindingHash: sha256(bindingProjection),
    status: "pass",
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(verifySourceProvenance()));
  } catch (error) {
    const violation = error instanceof ControlViolation ? error : new ControlViolation("source-verification-failed");
    console.error(JSON.stringify({ schemaVersion: "breadboard.control-error.v1", code: violation.code, pathClass: violation.pathClass ?? null }));
    process.exit(1);
  }
}
