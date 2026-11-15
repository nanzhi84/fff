import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createJiti } from "jiti";
import { FileFinder } from "@ff-labs/fff-node";

const [queriesPath, outputPath, repsArg = "5"] = process.argv.slice(2);
if (!queriesPath || !outputPath)
  throw Error(
    "Usage: node bench/extension.mjs queries.json output.json [repetitions]",
  );
const reps = Number(repsArg),
  Q = JSON.parse(fs.readFileSync(queriesPath, "utf8"));
const dir = path.dirname(path.resolve(outputPath));
fs.mkdirSync(dir, { recursive: true });
const agent = fs.mkdtempSync(path.join(dir, "agent-"));
process.env.PI_CODING_AGENT_DIR = agent;
fs.writeFileSync(
  path.join(agent, "pi-fff.json"),
  JSON.stringify({
    mode: "tools-only",
    frecencyDbPath: path.join(agent, "f"),
    historyDbPath: path.join(agent, "h"),
  }),
);
const rss = () => process.memoryUsage().rss / 1048576;
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return {
    p50: s[Math.floor(s.length / 2)],
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
    min: s[0],
    max: s.at(-1),
  };
};
const unwrap = (r) => {
  if (!r.ok) throw Error(r.error);
  return r.value;
};
let finder, lastGrep, lastFind, createMs, initOptions;
globalThis.__fffSdkPromiseGlobal = Promise.resolve({
  FileFinder: {
    create(options) {
      const t = performance.now();
      const result = FileFinder.create(options);
      createMs = performance.now() - t;
      initOptions = options;
      if (result.ok) {
        finder = result.value;
        for (const method of ["grep", "fileSearch"]) {
          const fn = finder[method].bind(finder);
          finder[method] = (...args) => {
            const r = fn(...args);
            if (method === "grep") lastGrep = r;
            else lastFind = r;
            return r;
          };
        }
      }
      return result;
    },
  },
});
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { default: extension } = await jiti.import("../src/index.ts");
const events = new Map(),
  tools = new Map(),
  notices = [];
const ctx = {
  cwd: Q.meta.root,
  sessionManager: { getEntries: () => [] },
  ui: { notify: (...x) => notices.push(x), setStatus() {} },
};
extension({
  on: (n, f) => events.set(n, f),
  getFlag: () => undefined,
  registerFlag() {},
  registerCommand() {},
  registerTool: (t) => tools.set(t.name, t),
  getActiveTools: () => ["read"],
  setActiveTools() {},
  appendEntry() {},
});
const out = {
  corpus: Q.meta.corpus,
  root: Q.meta.root,
  repetitions: reps,
  implementation:
    "actual extension tool execute (includes formatting and fallback)",
  scans: {},
  probes: [],
  grep: { 20: {}, 100: {} },
  find: {},
  memory: {},
  notices,
};
const call = (name, args) =>
  tools.get(name).execute("bench", args, new AbortController().signal);
async function grep(q, limit) {
  lastGrep = null;
  const t = performance.now();
  const r = await call("ffgrep", {
    pattern: q.pattern,
    ...(q.pathConstraint ? { path: q.pathConstraint } : {}),
    limit,
  });
  const ms = performance.now() - t;
  const v = lastGrep ? unwrap(lastGrep) : { items: [] };
  return {
    ms,
    outputText: r.content[0].text,
    items: v.items.map((i) => ({
      file: i.relativePath,
      line: i.lineNumber,
      text: i.lineContent,
    })),
    totalMatched: r.details?.totalMatched,
    totalFiles: v.totalFiles,
    totalFilesSearched: v.totalFilesSearched,
    filteredFileCount: v.filteredFileCount,
    hasNext: !!v.nextCursor,
  };
}
async function find(q) {
  lastFind = null;
  const t = performance.now();
  const r = await call("fffind", { pattern: q.query, limit: 30 });
  const ms = performance.now() - t;
  const v = unwrap(lastFind);
  const output = r.content[0].text;
  const shown = new Set(output.split("\n").map((l) => l.split("  [")[0]));
  return {
    ms,
    outputText: output,
    files: v.items
      .filter((i) => shown.has(i.relativePath))
      .map((i) => i.relativePath),
    totalMatched: v.totalMatched,
    totalFiles: v.totalFiles,
  };
}
let peak = rss();
out.memory.rssBeforeInitMb = peak;
const sampler = setInterval(() => {
  peak = Math.max(peak, rss());
}, 50);
const t = performance.now();
try {
  await events.get("session_start")({}, ctx);
  if (!finder) throw Error(JSON.stringify(notices));
  out.scans.waitForScan = { ms: performance.now() - t, ok: true };
  out.scans.createMs = createMs;
  const ready = unwrap(await finder.waitForIndexReady(600000));
  if (!ready) throw Error("index readiness timed out");
  out.scans.indexReady = { ms: performance.now() - t, ok: true, value: ready };
  const progress = unwrap(finder.getScanProgress());
  out.scans.indexedFiles = progress.scannedFilesCount;
  out.scans.warmupComplete = progress.isWarmupComplete;
  out.memory.rssAfterReadyMb = rss();
  out.initOptions = initOptions;
  console.log(
    `ready ${out.scans.indexReady.ms.toFixed(0)} ms, RSS ${rss().toFixed(0)} MiB`,
  );
  for (const limit of [20, 100])
    for (const q of Q.grepQueries) {
      const lat = [];
      let best;
      for (let i = 0; i < reps; i++) {
        best = await grep(q, limit);
        lat.push(best.ms);
      }
      out.grep[limit][q.id] = {
        ...q,
        truth: undefined,
        latency: stats(lat),
        best,
      };
    }
  console.log("grep complete");
  for (const q of Q.findQueries) {
    const lat = [];
    let best;
    for (let i = 0; i < reps; i++) {
      best = await find(q);
      lat.push(best.ms);
    }
    out.find[q.id] = { ...q, latency: stats(lat), best };
  }
  out.find.__learned = {};
  for (const q of Q.findQueries) {
    for (let i = 0; i < 3; i++) {
      const r = await find(q);
      if (r.files.includes(q.gold))
        await events.get("tool_result")(
          {
            toolName: "read",
            isError: false,
            input: { path: path.join(Q.meta.root, q.gold) },
          },
          ctx,
        );
    }
    const r = await find(q);
    out.find.__learned[q.id] = { ...q, latency: stats([r.ms]), best: r };
  }
  out.memory.peakRssMb = Math.max(peak, rss());
  out.memory.rssEndMb = rss();
  fs.writeFileSync(outputPath, JSON.stringify(out));
  console.log(`saved ${outputPath}`);
} finally {
  clearInterval(sampler);
  await events.get("session_shutdown")({}, ctx);
  fs.rmSync(agent, { recursive: true, force: true });
}
