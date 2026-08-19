import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const projects = [
  ["desktop", "../scripts/check-e2e-bootstrap.mjs"],
  ["web", "../scripts/check-e2e-bootstrap.mjs"],
];
const imports = 'import { test, bootstrapE2ePage } from "../helpers/test";';
const spec = (body) =>
  `${imports}\ntest("x", async ({ page }) => { ${body} });`;

for (const [project, checkerPath] of projects) {
  const { checkSource, runCheck } = await import(checkerPath);
  const accepts = (source) => assert.equal(checkSource(source), undefined);
  const rejects = (source) => assert.notEqual(checkSource(source), undefined);

  test(`${project}: accepts direct, hook, and beforeNavigate bootstrap patterns`, () => {
    accepts(spec("await bootstrapE2ePage(page);"));
    accepts(
      `${imports}\ntest.beforeEach(async ({ page }) => { await bootstrapE2ePage(page); });\ntest("x", async ({ page }) => { await page.title(); });`,
    );
    accepts(
      spec(
        "await bootstrapE2ePage(page, { beforeNavigate: async () => page.addInitScript(() => {}) });",
      ),
    );
  });

  test(`${project}: accepts module helpers and ratified containers`, () => {
    accepts(
      `${imports}\nasync function open(page) { return await bootstrapE2ePage(page); }\ntest("x", async ({ page }) => { const response = await open(page); void response; });`,
    );
    accepts(
      spec(
        "try { await bootstrapE2ePage(page); } finally { await page.title(); }",
      ),
    );
    accepts(
      spec(
        "try { await page.title(); } finally { await bootstrapE2ePage(page); }",
      ),
    );
    accepts(
      spec("for (const attempt of [0, 1]) { await bootstrapE2ePage(page); }"),
    );
    accepts(
      spec(
        "for (let attempt = 0; attempt < 2; attempt += 1) { await bootstrapE2ePage(page); }",
      ),
    );
  });

  test(`${project}: ignores destructuring property keys with different bound locals`, () => {
    accepts(
      spec(
        "const { test: localTest, bootstrapE2ePage: localBootstrap } = helpers; void localTest; void localBootstrap; await bootstrapE2ePage(page);",
      ),
    );
  });

  for (const [name, source] of [
    [
      ".ts helper suffix",
      'import { test, bootstrapE2ePage } from "../helpers/test.ts"; test("x", async () => {});',
    ],
    [
      "import alias",
      'import { test as e2eTest, bootstrapE2ePage } from "../helpers/test"; e2eTest("x", async () => { await bootstrapE2ePage(); });',
    ],
    [
      "re-export",
      'import { test, bootstrapE2ePage } from "./reexport"; test("x", async () => { await bootstrapE2ePage(); });',
    ],
    [
      "dynamic import",
      'const { test, bootstrapE2ePage } = await import("../helpers/test"); test("x", async () => { await bootstrapE2ePage(); });',
    ],
    [
      "dead-code call",
      `${imports}\nasync function never(page) { await bootstrapE2ePage(page); } test("x", async () => {});`,
    ],
    [
      "comment",
      `${imports}\n// await bootstrapE2ePage(page)\ntest("x", async () => {});`,
    ],
    [
      "string",
      `${imports}\nconst hint = "await bootstrapE2ePage(page)"; test("x", async () => {});`,
    ],
    [
      "mixed safe and unsafe tests",
      `${imports}\ntest("safe", async ({ page }) => { await bootstrapE2ePage(page); }); test("unsafe", async () => {});`,
    ],
    ["if-wrapped call", spec("if (true) { await bootstrapE2ePage(page); }")],
    [
      "catch-only call",
      spec(
        "try { await page.title(); } catch { await bootstrapE2ePage(page); }",
      ),
    ],
    [
      "zero-iteration false loop",
      spec("for (; false;) { await bootstrapE2ePage(page); }"),
    ],
    [
      "zero-iteration empty iterable",
      spec("for (const value of []) { await bootstrapE2ePage(page); }"),
    ],
    [
      "uncalled nested function",
      spec("async function setup() { await bootstrapE2ePage(page); }"),
    ],
    [
      "unawaited helper",
      `${imports}\nasync function open(page) { await bootstrapE2ePage(page); }\ntest("x", async ({ page }) => { open(page); });`,
    ],
    [
      "fake test.extend",
      `${imports}\ntest.extend("x", async ({ page }) => { await bootstrapE2ePage(page); });`,
    ],
    [
      "misplaced describe hook",
      `${imports}\ntest.describe("inside", () => { test.beforeEach(async ({ page }) => { await bootstrapE2ePage(page); }); test("covered", async () => {}); }); test("outside", async () => {});`,
    ],
    [
      "shadowed bootstrap",
      `${imports}\ntest("x", async ({ page }) => { const bootstrapE2ePage = async () => {}; await bootstrapE2ePage(page); });`,
    ],
    [
      "object shorthand binding shadow",
      spec(
        "const { bootstrapE2ePage } = helpers; await bootstrapE2ePage(page);",
      ),
    ],
    [
      "nested object alias binding shadow",
      spec(
        "const { bootstrap: { run: bootstrapE2ePage } } = helpers; await bootstrapE2ePage(page);",
      ),
    ],
    [
      "nested array default binding shadow",
      spec("const [[test = fallback]] = values; await bootstrapE2ePage(page);"),
    ],
    [
      "object rest binding shadow",
      spec(
        "const { ignored, ...bootstrapE2ePage } = helpers; await bootstrapE2ePage(page);",
      ),
    ],
    [
      "destructured function parameter shadow",
      spec(
        "function configure({ nested: [bootstrapE2ePage] }) {} await bootstrapE2ePage(page);",
      ),
    ],
    [
      "destructured arrow parameter shadow",
      spec(
        "const configure = ([{ test }]) => {}; await bootstrapE2ePage(page);",
      ),
    ],
    [
      "destructured method parameter shadow",
      spec(
        "class Harness { configure({ helper: { bootstrapE2ePage = fallback } }) {} } await bootstrapE2ePage(page);",
      ),
    ],
    [
      "parenthesized false condition",
      spec("while (((false))) { await bootstrapE2ePage(page); }"),
    ],
    [
      "parenthesized empty array iterable",
      spec("for (const value of (([]))) { await bootstrapE2ePage(page); }"),
    ],
    [
      "parenthesized empty string iterable",
      spec('for (const value of ((""))) { await bootstrapE2ePage(page); }'),
    ],
    [
      "parenthesized empty object for-in",
      spec("for (const key in (({}))) { await bootstrapE2ePage(page); }"),
    ],
  ]) {
    test(`${project}: rejects ${name}`, () => rejects(source));
  }

  test(`${project}: discovers nested specs with a canonical relative import`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bootstrap-"));
    try {
      fs.mkdirSync(path.join(root, "tests/e2e/nested"), { recursive: true });
      fs.mkdirSync(path.join(root, "tests/helpers"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "tests/helpers/test.ts"),
        "export {};\n",
      );
      fs.writeFileSync(
        path.join(root, "tests/e2e/nested/example.spec.ts"),
        'import { test, bootstrapE2ePage } from "../../helpers/test"; test("x", async ({ page }) => { await bootstrapE2ePage(page); });',
      );
      assert.deepEqual(runCheck(root), []);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const [project, checkerPath] of projects) {
  const { checkSource } = await import(checkerPath);
  test(`${project}: traverses canonical parameterized registration containers only`, () => {
    assert.equal(
      checkSource(`${imports}
        for (const name of ["one", "two"]) test(name, async ({ page }) => { await bootstrapE2ePage(page); });
        ["three"].forEach((name) => test(name, async ({ page }) => { await bootstrapE2ePage(page); }));
        ["four"].map((name) => test(name, async ({ page }) => { await bootstrapE2ePage(page); }));`),
      undefined,
    );
    assert.notEqual(
      checkSource(`${imports}
        function registerLater() { test("hidden", async ({ page }) => { await bootstrapE2ePage(page); }); }
        test("unsafe", async () => {});`),
      undefined,
    );
  });
}
