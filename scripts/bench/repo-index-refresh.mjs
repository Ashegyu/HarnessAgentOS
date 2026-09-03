import { performance } from "node:perf_hooks";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepoIndexService } from "../../packages/agent/src/repo-index-service.ts";

const fileCount = Number.parseInt(process.env.HARNESS_BENCH_FILES ?? "800", 10);
const warmRuns = Number.parseInt(process.env.HARNESS_BENCH_RUNS ?? "7", 10);
const root = await mkdtemp(join(tmpdir(), "harness-repo-index-bench-"));

try {
  await mkdir(join(root, "src"));
  await Promise.all(
    Array.from({ length: fileCount }, (_, index) =>
      writeFile(
        join(root, "src", `module-${String(index).padStart(4, "0")}.ts`),
        `import { join } from "node:path";\nexport const value${index} = join("a", "${index}");\n`,
        "utf8",
      ),
    ),
  );

  let rows = [];
  let upsertedRows = 0;
  const store = {
    upsertMany: async (files) => {
      upsertedRows += files.length;
      const byPath = new Map(rows.map((row) => [row.relativePath, row]));
      for (const file of files) byPath.set(file.relativePath, file);
      rows = [...byPath.values()];
    },
    deleteMissing: async ({ keepRelativePaths }) => {
      const keep = new Set(keepRelativePaths);
      rows = rows.filter((row) => keep.has(row.relativePath));
    },
    listByTarget: async ({ limit }) =>
      rows
        .slice()
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        .slice(0, limit),
  };
  const service = new RepoIndexService({ store });

  const coldStarted = performance.now();
  await service.refresh({ projectKey: "bench", targetDir: root, maxFiles: fileCount });
  const coldMs = performance.now() - coldStarted;

  const warmDurationsMs = [];
  upsertedRows = 0;
  for (let index = 0; index < warmRuns; index += 1) {
    const started = performance.now();
    await service.refresh({ projectKey: "bench", targetDir: root, maxFiles: fileCount });
    warmDurationsMs.push(performance.now() - started);
  }

  const sorted = warmDurationsMs.slice().sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  process.stdout.write(
    `${JSON.stringify({
      fileCount,
      warmRuns,
      coldMs: round(coldMs),
      warmP50Ms: round(p50),
      warmP95Ms: round(p95),
      warmUpsertedRows: upsertedRows,
    })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

function round(value) {
  return Math.round(value * 100) / 100;
}
