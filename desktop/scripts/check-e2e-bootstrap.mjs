import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const SPEC_PATTERN = /\.(spec|perf)\.ts$/;
const exempt = new Set(["agents-everywhere.live.spec.ts"]);
const TEST_MEMBERS = new Set(["only", "skip", "fixme", "fail"]);
const CONTAINERS = new Set(["forEach", "map"]);

function callbackOf(call) {
  const callback = call.arguments.at(-1);
  return callback &&
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
    ? callback
    : undefined;
}

function memberOf(call) {
  return ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === "test"
    ? call.expression.name.text
    : undefined;
}

function helperImport(file, filename, canonicalHelperPath) {
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue;
    const resolved = path.resolve(
      path.dirname(filename),
      `${statement.moduleSpecifier.text}.ts`,
    );
    const canonical = canonicalHelperPath
      ? resolved === canonicalHelperPath
      : statement.moduleSpecifier.text === "../helpers/test";
    if (!canonical) continue;
    const elements = statement.importClause?.namedBindings;
    if (!elements || !ts.isNamedImports(elements)) return undefined;
    const names = new Map(
      elements.elements.map((element) => [
        element.name.text,
        element.propertyName?.text ?? element.name.text,
      ]),
    );
    if (
      names.get("test") === "test" &&
      names.get("bootstrapE2ePage") === "bootstrapE2ePage"
    )
      return { test: "test", bootstrap: "bootstrapE2ePage" };
  }
}

function bindingNameShadows(name, canonical) {
  if (ts.isIdentifier(name))
    return name.text === canonical.test || name.text === canonical.bootstrap;
  return name.elements.some(
    (element) =>
      !ts.isOmittedExpression(element) &&
      bindingNameShadows(element.name, canonical),
  );
}

function hasShadowingDeclaration(file, canonical) {
  let shadowed = false;
  const visit = (node) => {
    if (shadowed) return;
    if (
      ts.isVariableDeclaration(node) &&
      bindingNameShadows(node.name, canonical)
    ) {
      shadowed = true;
      return;
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name) &&
      (node.name.text === canonical.test ||
        node.name.text === canonical.bootstrap)
    ) {
      shadowed = true;
      return;
    }
    if (
      (ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node)) &&
      node.parameters.some((parameter) =>
        bindingNameShadows(parameter.name, canonical),
      )
    ) {
      shadowed = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    visit(statement);
  }
  return shadowed;
}

function collectModuleHelpers(file) {
  const helpers = new Map();
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      helpers.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        )
          helpers.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return helpers;
}

function awaitedCall(statement) {
  const expression =
    ts.isExpressionStatement(statement) || ts.isReturnStatement(statement)
      ? statement.expression
      : ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.length === 1
        ? statement.declarationList.declarations[0].initializer
        : undefined;
  return expression &&
    ts.isAwaitExpression(expression) &&
    ts.isCallExpression(expression.expression)
    ? expression.expression
    : undefined;
}

function isAwaitedCall(statement, name) {
  const call = awaitedCall(statement);
  return (
    call && ts.isIdentifier(call.expression) && call.expression.text === name
  );
}

function unwrapParentheses(expression) {
  while (ts.isParenthesizedExpression(expression))
    expression = expression.expression;
  return expression;
}

function isStaticallyEmptyLoop(statement) {
  if (ts.isForStatement(statement)) {
    const condition = statement.condition
      ? unwrapParentheses(statement.condition)
      : undefined;
    return condition?.kind === ts.SyntaxKind.FalseKeyword;
  }
  if (ts.isWhileStatement(statement))
    return (
      unwrapParentheses(statement.expression).kind ===
      ts.SyntaxKind.FalseKeyword
    );
  if (ts.isForOfStatement(statement)) {
    const expression = unwrapParentheses(statement.expression);
    return (
      (ts.isArrayLiteralExpression(expression) &&
        !expression.elements.length) ||
      (ts.isStringLiteral(expression) && !expression.text.length)
    );
  }
  if (ts.isForInStatement(statement)) {
    const expression = unwrapParentheses(statement.expression);
    return (
      ts.isObjectLiteralExpression(expression) && !expression.properties.length
    );
  }
  return false;
}

function statementBootstraps(statement, canonical, helpers, seen) {
  if (isAwaitedCall(statement, canonical.bootstrap)) return true;
  const call = awaitedCall(statement);
  if (call && ts.isIdentifier(call.expression)) {
    const helperName = call.expression.text;
    const helper = helpers.get(helperName);
    if (helper && !seen.has(helperName)) {
      seen.add(helperName);
      if (callbackBootstraps(helper, canonical, helpers, seen)) return true;
    }
  }
  if (ts.isBlock(statement))
    return statement.statements.some((child) =>
      statementBootstraps(child, canonical, helpers, seen),
    );
  if (ts.isTryStatement(statement))
    return (
      statementBootstraps(statement.tryBlock, canonical, helpers, seen) ||
      Boolean(
        statement.finallyBlock &&
          statementBootstraps(statement.finallyBlock, canonical, helpers, seen),
      )
    );
  if (
    (ts.isForStatement(statement) ||
      ts.isForInStatement(statement) ||
      ts.isForOfStatement(statement) ||
      ts.isWhileStatement(statement) ||
      ts.isDoStatement(statement)) &&
    !isStaticallyEmptyLoop(statement)
  )
    return statementBootstraps(statement.statement, canonical, helpers, seen);
  return false;
}

function callbackBootstraps(callback, canonical, helpers, seen = new Set()) {
  const statements = ts.isBlock(callback.body)
    ? callback.body.statements
    : [ts.factory.createExpressionStatement(callback.body)];
  return statements.some((statement) =>
    statementBootstraps(statement, canonical, helpers, seen),
  );
}

function makeScope(parent) {
  return { parent, hooks: [], tests: [], children: [] };
}

function scanFile(file, canonical) {
  const helpers = collectModuleHelpers(file);
  const root = makeScope(undefined);
  const isTestCall = (call) =>
    ts.isIdentifier(call.expression) && call.expression.text === canonical.test;
  const isMember = (call, name) => memberOf(call) === name;

  const scanStatements = (statements, scope) => {
    for (const statement of statements) {
      if (ts.isBlock(statement)) {
        scanStatements(statement.statements, scope);
        continue;
      }
      if (
        ts.isForStatement(statement) ||
        ts.isForInStatement(statement) ||
        ts.isForOfStatement(statement)
      ) {
        scanStatements(
          ts.isBlock(statement.statement)
            ? statement.statement.statements
            : [statement.statement],
          scope,
        );
        continue;
      }
      if (
        !ts.isExpressionStatement(statement) ||
        !ts.isCallExpression(statement.expression)
      )
        continue;
      const call = statement.expression;
      const callback = callbackOf(call);
      if (isMember(call, "describe") && callback) {
        const child = makeScope(scope);
        scope.children.push(child);
        if (ts.isBlock(callback.body))
          scanStatements(callback.body.statements, child);
        continue;
      }
      if (isMember(call, "beforeEach") && callback) {
        scope.hooks.push(callbackBootstraps(callback, canonical, helpers));
        continue;
      }
      if (
        isTestCall(call) ||
        (memberOf(call) && TEST_MEMBERS.has(memberOf(call)))
      ) {
        if (callback)
          scope.tests.push(callbackBootstraps(callback, canonical, helpers));
        continue;
      }
      if (
        ts.isPropertyAccessExpression(call.expression) &&
        CONTAINERS.has(call.expression.name.text) &&
        callback &&
        ts.isArrayLiteralExpression(call.expression.expression)
      ) {
        if (ts.isBlock(callback.body))
          scanStatements(callback.body.statements, scope);
      }
    }
  };
  scanStatements(file.statements, root);
  return root;
}

function everyTestCovered(scope, inheritedHook = false) {
  const coveredByHook = inheritedHook || scope.hooks.some(Boolean);
  return (
    scope.tests.every((covered) => coveredByHook || covered) &&
    scope.children.every((child) => everyTestCovered(child, coveredByHook))
  );
}

function testCount(scope) {
  return (
    scope.tests.length +
    scope.children.reduce((count, child) => count + testCount(child), 0)
  );
}

export function checkSource(
  source,
  filename = "fixture.spec.ts",
  canonicalHelperPath,
) {
  const file = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const canonical = helperImport(file, filename, canonicalHelperPath);
  if (!canonical)
    return "must directly import unaliased test and bootstrapE2ePage from the canonical tests/helpers/test module";
  if (hasShadowingDeclaration(file, canonical))
    return "must not shadow canonical test or bootstrapE2ePage imports";
  const scope = scanFile(file, canonical);
  if (!testCount(scope)) return "does not register a browser test";
  if (!everyTestCovered(scope))
    return "must structurally await bootstrapE2ePage for every test, directly or through an applicable ancestor test.beforeEach";
}

function specFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) return specFiles(child);
    return entry.isFile() && SPEC_PATTERN.test(entry.name) ? [child] : [];
  });
}

export function runCheck(projectRoot) {
  const e2eRoot = path.join(projectRoot, "tests/e2e");
  const canonicalHelperPath = path.join(projectRoot, "tests/helpers/test.ts");
  return specFiles(e2eRoot).flatMap((filename) => {
    const relative = path.relative(e2eRoot, filename);
    if (exempt.has(relative)) return [];
    const violation = checkSource(
      fs.readFileSync(filename, "utf8"),
      filename,
      canonicalHelperPath,
    );
    return violation ? [`${relative}: ${violation}`] : [];
  });
}

if (process.argv[1] === import.meta.filename) {
  const violations = runCheck(path.resolve(import.meta.dirname, ".."));
  if (violations.length) {
    console.error(
      `E2E specs must register bootstrapE2ePage after their setup:\n${violations.join("\n")}`,
    );
    process.exit(1);
  }
}
