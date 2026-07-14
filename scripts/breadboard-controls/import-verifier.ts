import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ts } from "ts-morph";
import { validateExclusions } from "./source-verifier.ts";
import type { ExclusionManifest } from "./source-verifier.ts";

const ORACLE_BASE = "3047c27c332c5629c8e063283d349384c10c9a56";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE_EXTENSIONS: Record<string, true> = {
  ".cjs": true,
  ".cts": true,
  ".js": true,
  ".jsx": true,
  ".mjs": true,
  ".mts": true,
  ".ts": true,
  ".tsx": true,
};

export class ImportViolation extends Error {
  constructor(readonly code: string, readonly sourceClass: string) {
    super(`${code}:${sourceClass}`);
    this.name = "ImportViolation";
  }
}

export interface ImportFinding {
  sourcePath: string;
  kind: "static-import" | "static-export" | "import-equals" | "require" | "dynamic-import" | "import-type";
  classification: "bare" | "local";
}

function normalizeSourcePath(path: string): string {
  const normalized = path.split(sep).join("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ImportViolation("source-path-not-normalized", "source");
  }
  return normalized;
}

function literalModuleSpecifier(node: ts.Expression | ts.TypeNode): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function isRequireCallee(node: ts.Expression): boolean {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  if (ts.isIdentifier(current)) return current.text === "require";
  if (ts.isPropertyAccessExpression(current)) return current.name.text === "require";
  if (ts.isElementAccessExpression(current)) {
    return current.argumentExpression !== undefined && literalModuleSpecifier(current.argumentExpression) === "require";
  }
  if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return isRequireCallee(current.right);
  }
  return false;
}

function sourceKind(path: string): ts.ScriptKind {
  const extension = extname(path).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function classifySpecifier(
  sourcePath: string,
  specifier: string,
  exclusions: ExclusionManifest,
  kind: ImportFinding["kind"],
  stage: string,
  root: string,
): ImportFinding {
  if (specifier.length === 0 || specifier.includes("\0") || specifier.includes("\\")) {
    throw new ImportViolation("module-specifier-invalid", "specifier");
  }
  const bare = !specifier.startsWith(".") && !specifier.startsWith("/");
  let segments: string[];
  let classification: ImportFinding["classification"];
  const forbiddenPrefixes = exclusions.stageForbiddenImportSpecifierPrefixes[stage];
  if (!forbiddenPrefixes) throw new ImportViolation("control-stage-unknown", "manifest");
  if (bare) {
    classification = "bare";
    segments = specifier.split("/").filter(Boolean);
    if (forbiddenPrefixes.some((prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`))) {
      throw new ImportViolation("forbidden-import-island", "forbidden-package");
    }
  } else {
    classification = "local";
    const sourceDirectory = dirname(resolve(root, sourcePath));
    const target = resolve(sourceDirectory, specifier);
    const relativeTarget = relative(root, target).split(sep).join("/");
    if (relativeTarget === ".." || relativeTarget.startsWith("../") || relativeTarget.startsWith("/")) {
      throw new ImportViolation("local-import-escapes-root", "path-escape");
    }
    segments = relativeTarget.split("/").filter(Boolean);
    if (forbiddenPrefixes.some((prefix) => relativeTarget === prefix || relativeTarget.startsWith(`${prefix}/`))) {
      throw new ImportViolation("forbidden-import-island", "forbidden-package");
    }
  }
  if (segments.some((segment) => exclusions.forbiddenImportPathSegments.includes(segment.toLowerCase()))) {
    throw new ImportViolation("forbidden-import-island", "vendored-generated-patch");
  }
  return { sourcePath, kind, classification };
}

export function scanSourceText(
  sourcePath: string,
  sourceText: string,
  exclusions: ExclusionManifest,
  stage = "A1",
  root = ROOT,
): ImportFinding[] {
  const normalizedPath = normalizeSourcePath(sourcePath);
  const sourceFile = ts.createSourceFile(
    normalizedPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    sourceKind(normalizedPath),
  );
  if (!("parseDiagnostics" in sourceFile) || !Array.isArray(sourceFile.parseDiagnostics)) {
    throw new ImportViolation("source-parser-diagnostics-missing", "typescript-parser");
  }
  if (sourceFile.parseDiagnostics.length > 0) {
    throw new ImportViolation("source-parse-failed", "typescript-syntax");
  }
  const findings: ImportFinding[] = [];
  const record = (kind: ImportFinding["kind"], expression: ts.Expression | ts.TypeNode | undefined): void => {
    if (!expression) throw new ImportViolation("module-specifier-missing", kind);
    const specifier = literalModuleSpecifier(expression);
    if (specifier === undefined) throw new ImportViolation("module-specifier-nonliteral", kind);
    findings.push(classifySpecifier(normalizedPath, specifier, exclusions, kind, stage, root));
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      record("static-import", node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      record("static-export", node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      record("import-equals", node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments.length !== 1) throw new ImportViolation("dynamic-import-arity", "dynamic-import");
        record("dynamic-import", node.arguments[0]);
      } else if (isRequireCallee(node.expression)) {
        if (node.arguments.length !== 1) throw new ImportViolation("require-arity", "require");
        record("require", node.arguments[0]);
      }
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      record("import-type", ts.isLiteralTypeNode(argument) ? argument.literal : argument);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function runGit(args: string[], code: string, root: string): Uint8Array {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "" },
  });
  if (result.exitCode !== 0) throw new ImportViolation(code, "repository");
  return result.stdout;
}

function nulRecords(bytes: Uint8Array): string[] {
  const records = Buffer.from(bytes).toString("utf8").split("\0");
  if (records.at(-1) === "") records.pop();
  return records;
}

function changedSourcePaths(root: string): string[] {
  const changed = nulRecords(runGit(["diff", "--name-only", "--no-renames", "-z", ORACLE_BASE, "--"], "git-diff-failed", root));
  const untracked = nulRecords(runGit(["ls-files", "--others", "--exclude-standard", "-z"], "git-untracked-failed", root));
  return [...new Set([...changed, ...untracked])]
    .map(normalizeSourcePath)
    .filter((path) => SOURCE_EXTENSIONS[extname(path).toLowerCase()] === true)
    .filter((path) => existsSync(resolve(root, path)))
    .sort();
}

export interface ImportVerificationSummary {
  schemaVersion: "breadboard.import-verification.v1";
  sourceFileCount: number;
  importEdgeCount: number;
  staticEdgeCount: number;
  requireEdgeCount: number;
  dynamicEdgeCount: number;
  classifiedPathHash: string;
  status: "pass";
}

export function verifyImports(root = ROOT): ImportVerificationSummary {
  let exclusions: unknown;
  let packageDocument: unknown;
  try {
    exclusions = JSON.parse(readFileSync(resolve(root, "scripts/breadboard-controls/source-exclusions.json"), "utf8"));
    packageDocument = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    validateExclusions(exclusions);
  } catch {
    throw new ImportViolation("control-manifest-invalid", "manifest");
  }
  if (
    !packageDocument ||
    typeof packageDocument !== "object" ||
    Array.isArray(packageDocument) ||
    !("breadboardControls" in packageDocument) ||
    !packageDocument.breadboardControls ||
    typeof packageDocument.breadboardControls !== "object" ||
    Array.isArray(packageDocument.breadboardControls) ||
    !("stage" in packageDocument.breadboardControls) ||
    typeof packageDocument.breadboardControls.stage !== "string"
  ) {
    throw new ImportViolation("control-stage-invalid", "manifest");
  }
  const stage = packageDocument.breadboardControls.stage;
  const sources = changedSourcePaths(root);
  const findings = sources.flatMap((path) =>
    scanSourceText(path, readFileSync(resolve(root, path), "utf8"), exclusions, stage, root),
  );
  const staticEdgeCount = findings.filter((finding) =>
    finding.kind === "static-import" || finding.kind === "static-export" || finding.kind === "import-equals" || finding.kind === "import-type"
  ).length;
  const requireEdgeCount = findings.filter((finding) => finding.kind === "require").length;
  const dynamicEdgeCount = findings.filter((finding) => finding.kind === "dynamic-import").length;
  const classified = findings
    .map((finding) => `${finding.sourcePath}\t${finding.kind}\t${finding.classification}`)
    .sort()
    .join("\n");
  return {
    schemaVersion: "breadboard.import-verification.v1",
    sourceFileCount: sources.length,
    importEdgeCount: findings.length,
    staticEdgeCount,
    requireEdgeCount,
    dynamicEdgeCount,
    classifiedPathHash: createHash("sha256").update(classified).digest("hex"),
    status: "pass",
  };
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(verifyImports()));
  } catch (error) {
    const violation = error instanceof ImportViolation ? error : new ImportViolation("import-verification-failed", "internal");
    console.error(JSON.stringify({ schemaVersion: "breadboard.control-error.v1", code: violation.code, pathClass: violation.sourceClass }));
    process.exit(1);
  }
}
