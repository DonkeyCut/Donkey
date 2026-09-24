import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const site = fileURLToPath(new URL("../", import.meta.url));
const rules = ["export-list-reads", "all-apis", "frontend"].map((name) =>
  JSON.parse(readFileSync(new URL(`../firewall/${name}.json`, import.meta.url), "utf8")));
const live = rules.map((rule, index) => ({ ...rule, id: `rule_${index}`, _status: "live" }));

function run(mode, remote) {
  const directory = mkdtempSync(join(tmpdir(), "donkey-firewall-test-"));
  try {
    const executable = join(directory, "npx");
    const calls = join(directory, "calls.jsonl");
    writeFileSync(executable, `#!${process.execPath}\n` +
      'const fs = require("node:fs"); const args = process.argv.slice(2);\n' +
      'fs.appendFileSync(process.env.FIREWALL_TEST_CALLS, JSON.stringify(args) + "\\n");\n' +
      'if (args.includes("list")) process.stdout.write(process.env.FIREWALL_TEST_REMOTE);\n');
    chmodSync(executable, 0o755);
    const result = spawnSync(process.execPath, ["scripts/firewall.mjs", mode], {
      cwd: site,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        FIREWALL_TEST_CALLS: calls,
        FIREWALL_TEST_REMOTE: JSON.stringify(remote),
      },
    });
    return { ...result, calls: readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("the broad rule covers every API route and method without including pages", () => {
  const condition = rules[1].conditionGroup[0].conditions;
  assert.equal(condition.length, 1);
  assert.equal(condition[0].type, "path");
  const pattern = new RegExp(condition[0].value);
  const paths = execFileSync("git", ["ls-files", "src/app/api/**/route.ts"], { cwd: site, encoding: "utf8" }).trim().split("\n");
  assert.ok(paths.length > 50);
  for (const path of paths) assert.ok(pattern.test(path.replace("src/app", "").replace("/route.ts", "")), path);
  assert.ok(pattern.test("/api"));
  for (const path of ["/apiary", "/app", "/sign-in"]) assert.equal(pattern.test(path), false);
  const [exportPath, method] = rules[0].conditionGroup[0].conditions;
  assert.equal(method.value, "GET");
  assert.ok(new RegExp(exportPath.value).test("/api/cut-cloud/projects/example/exports"));
  assert.equal(new RegExp(exportPath.value).test("/api/cut-cloud/projects/example/exports/file"), false);
});

test("matching published rules are a no-op, including provider metadata", () => {
  const remote = structuredClone(live);
  remote[0].action.mitigate.actionDuration = null;
  remote[0].conditionGroup[0].conditions[0].neg = false;
  for (const mode of ["check", "stage"]) {
    const result = run(mode, { rules: remote, hasDraft: false });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.calls.length, 1);
  }
});

test("frontend protection covers page and dynamic asset requests across hosts and methods", () => {
  const conditions = rules[2].conditionGroup[0].conditions;
  assert.equal(conditions.length, 1);
  const condition = conditions[0];
  assert.equal(condition.type, "path");
  assert.equal(condition.neg, true);
  const excluded = new RegExp(condition.value);
  for (const path of ["/", "/app", "/app/p/example", "/sign-in", "/s/example/card/image.png", "/_next/image", "/_next/data/build/app.json"]) {
    assert.equal(excluded.test(path), false, path);
  }
  for (const path of ["/api", "/api/auth/get-session", "/api/inference/responses", "/_next/static/chunks/app.js", "/_next/static/css/app.css"]) {
    assert.equal(excluded.test(path), true, path);
  }
});

test("pending drafts prevent both checks and mutations", () => {
  for (const mode of ["check", "stage"]) {
    const result = run(mode, { rules: live, hasDraft: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.calls.length, 1);
  }
});

test("condition negation is detected as drift", () => {
  const remote = structuredClone(live);
  remote[1].conditionGroup[0].conditions[0].neg = true;
  const result = run("check", { rules: remote, hasDraft: false });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Firewall drift/);
});

test("staging creates only the missing rule and leaves publication to the operator", () => {
  const result = run("stage", { rules: [live[0], live[2]], hasDraft: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.length, 3);
  const create = result.calls[1];
  assert.ok(create.includes("add"));
  assert.deepEqual(JSON.parse(create[create.indexOf("--json") + 1]), rules[1]);
  assert.ok(result.calls[2].includes("diff"));
  assert.equal(result.calls.some((args) => args.includes("publish")), false);
});

test("staging updates an existing rule by ID", () => {
  const remote = structuredClone(live);
  remote[1].action.mitigate.rateLimit.limit = 999;
  const result = run("stage", { rules: remote, hasDraft: false });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls[1].includes("edit"));
  assert.ok(result.calls[1].includes("rule_1"));
});
