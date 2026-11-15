import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
import { FileFinder } from "@ff-labs/fff-node";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fff-native-"));
const root = path.join(temp, "repo");
fs.mkdirSync(root);
const agent = path.join(temp, "agent");
fs.mkdirSync(agent);
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_FFF_MULTIGREP = "1";
fs.writeFileSync(
  path.join(agent, "pi-fff.json"),
  JSON.stringify({ maxFileSize: 32 * 1024 * 1024 }),
);
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
git("init", "-q");
for (const name of ["aaa", "bbb", "zzz"])
  fs.writeFileSync(path.join(root, `target-${name}.ts`), "// COMMON_NEEDLE\n");
fs.writeFileSync(
  path.join(root, "model.ts"),
  "export interface UniqueThing { x: number }\nlet ref: UniqueThing;\n",
);
git("add", ".");
git(
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
  "commit",
  "-qm",
  "fixture",
);
const big = path.join(root, "big.txt");
fs.writeFileSync(
  big,
  ("x".repeat(1023) + "\n").repeat(12 * 1024) + "UNIQUE_BIG_NEEDLE\n",
);
const created = [];
const unwrap = (r) => {
  assert.equal(r.ok, true, r.error);
  return r.value;
};
globalThis.__fffSdkPromiseGlobal = Promise.resolve({
  FileFinder: {
    create(options) {
      const result = FileFinder.create(options);
      if (result.ok) created.push({ options, finder: result.value });
      return result;
    },
  },
});
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { default: extension } = await jiti.import("../src/index.ts");
const events = new Map(),
  tools = new Map();
const notices = [];
const ctx = {
  cwd: root,
  sessionManager: { getEntries: () => [] },
  ui: { notify: (...args) => notices.push(args), setStatus() {} },
};
const pi = {
  on: (name, fn) => events.set(name, fn),
  getFlag: () => undefined,
  registerFlag() {},
  registerCommand() {},
  registerTool: (t) => tools.set(t.name, t),
  getActiveTools: () => ["read"],
  setActiveTools() {},
  appendEntry() {},
};
const call = (name, args) =>
  tools.get(name).execute("test", args, new AbortController().signal);
try {
  extension(pi);
  await events.get("session_start")({}, ctx);
  assert.equal(created.length, 1, JSON.stringify(notices));
  const { finder, options } = created[0];
  assert.equal(options.basePath, fs.realpathSync.native(root));
  assert.equal(options.cacheBudgetMaxFileSize, 32 * 1024 * 1024);
  assert.equal(unwrap(await finder.waitForIndexReady(60000)), true);
  assert.equal(unwrap(finder.fileSearch("model.ts")).items[0].gitStatus, "clean");
  fs.appendFileSync(path.join(root, "model.ts"), "// modified\n");
  unwrap(finder.refreshGitStatus());
  assert.equal(
    unwrap(finder.fileSearch("model.ts")).items[0].gitStatus,
    "modified",
  );
  const bigResult = await call("ffgrep", { pattern: "UNIQUE_BIG_NEEDLE" });
  assert.match(bigResult.content[0].text, /big.txt/);
  const multi = await call("fff-multi-grep", {
    patterns: ["UNIQUE_BIG_NEEDLE"],
  });
  assert.match(multi.content[0].text, /big.txt/);
  const defs = await call("ffgrep", {
    pattern: "UniqueThing",
    definitions_only: true,
  });
  assert.match(defs.content[0].text, /export interface/);
  assert.doesNotMatch(defs.content[0].text, /let ref/);
  const target = path.join(root, "target-zzz.ts");
  const rank = () => unwrap(finder.fileSearch("target", { pageSize: 20 }));
  assert.notEqual(rank().items[0].relativePath, "target-zzz.ts");
  await call("fffind", { pattern: "target" });
  await events.get("tool_result")(
    { toolName: "read", isError: true, input: { path: target } },
    ctx,
  );
  assert.equal(rank().scores[0].comboMatchBoost, 0);
  for (let i = 0; i < 10; i++) {
    await call("fffind", { pattern: "target" });
    await events.get("tool_result")(
      { toolName: "read", isError: false, input: { path: target } },
      ctx,
    );
  }
  assert.equal(rank().items[0].relativePath, "target-zzz.ts");
  assert.equal(rank().scores[0].comboMatchBoost, 1000);
  await events.get("tool_result")(
    { toolName: "read", isError: false, input: { path: target } },
    ctx,
  );
  assert.equal(
    rank().scores[0].comboMatchBoost,
    1000,
    "consume each selection only once",
  );
  await events.get("session_shutdown")({}, ctx);
  const child = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {FileFinder} from '@ff-labs/fff-node';
    const f=FileFinder.create(${JSON.stringify(options)}).value;
    await f.waitForIndexReady(60000);
    const r=f.fileSearch('target',{pageSize:20}).value;
    console.log(JSON.stringify({file:r.items[0].relativePath,boost:r.scores[0].comboMatchBoost}));
    f.destroy();
  `,
    ],
    { cwd: path.resolve(import.meta.dirname, "../../.."), encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(child), { file: "target-zzz.ts", boost: 1000 });
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "canonical git status",
        "configured 12 MiB grep",
        "multi-grep",
        "definition-only",
        "failed read does not learn",
        "successful selection learns once",
        "independent-process history persistence",
      ],
      notices,
    }),
  );
} finally {
  for (const { finder } of created) if (!finder.isDestroyed) finder.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
}
