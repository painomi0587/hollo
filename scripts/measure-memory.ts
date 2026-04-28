import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

import metadata from "../package.json" with { type: "json" };

interface MemorySample {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  totalHeapSize: number;
  usedHeapSize: number;
  totalAvailableSize: number;
  mallocedMemory: number;
  peakMallocedMemory: number;
}

interface MeasurementResult {
  before: MemorySample;
  after: MemorySample;
  delta: MemorySample;
  heapSnapshotPath: string | null;
}

interface Scenario {
  id: string;
  mode: "module" | "server";
  target: string;
  stabilizeMs?: number;
  env?: Record<string, string>;
}

interface ScenarioSummary {
  id: string;
  mode: Scenario["mode"];
  target: string;
  runs: number;
  medianAfter: MemorySample;
  medianDelta: MemorySample;
}

const MIB = 1024 * 1024;

const scenarios: Scenario[] = [
  {
    id: "server-all",
    mode: "server",
    target: "../bin/server.ts",
    stabilizeMs: 2000,
    env: { NODE_TYPE: "all", PORT: "0" },
  },
  {
    id: "server-web",
    mode: "server",
    target: "../bin/server.ts",
    stabilizeMs: 2000,
    env: { NODE_TYPE: "web", PORT: "0" },
  },
  {
    id: "server-worker",
    mode: "server",
    target: "../bin/server.ts",
    stabilizeMs: 2000,
    env: { NODE_TYPE: "worker", PORT: "0" },
  },
  {
    id: "module-text",
    mode: "module",
    target: "../src/text.ts",
  },
  {
    id: "module-storage",
    mode: "module",
    target: "../src/storage.ts",
  },
  {
    id: "module-index",
    mode: "module",
    target: "../src/index.tsx",
    stabilizeMs: 1500,
  },
  {
    id: "module-previewcard",
    mode: "module",
    target: "../src/previewcard.ts",
  },
  {
    id: "module-api-media",
    mode: "module",
    target: "../src/api/v1/media.ts",
  },
  {
    id: "module-federation-post",
    mode: "module",
    target: "../src/federation/post.ts",
  },
  {
    id: "module-page-login",
    mode: "module",
    target: "../src/pages/login.tsx",
  },
  {
    id: "module-page-auth",
    mode: "module",
    target: "../src/pages/auth.tsx",
  },
  {
    id: "module-page-setup",
    mode: "module",
    target: "../src/pages/setup/index.tsx",
  },
];

function parseArgs() {
  let repeats = 5;
  let filter: string | null = null;
  let snapshotScenario: string | null = null;

  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === "--") {
      continue;
    }

    if (arg === "--repeats") {
      const value = process.argv[i + 1];
      if (value == null) throw new Error("--repeats requires a value");
      repeats = Number.parseInt(value, 10);
      i += 1;
    } else if (arg === "--filter") {
      const value = process.argv[i + 1];
      if (value == null) throw new Error("--filter requires a value");
      filter = value;
      i += 1;
    } else if (arg === "--snapshot") {
      const value = process.argv[i + 1];
      if (value == null) throw new Error("--snapshot requires a scenario id");
      snapshotScenario = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new Error(`Invalid repeat count: ${repeats}`);
  }

  return { repeats, filter, snapshotScenario };
}

function metricMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

function sampleMedian(samples: MemorySample[]): MemorySample {
  return {
    rss: metricMedian(samples.map((sample) => sample.rss)),
    heapTotal: metricMedian(samples.map((sample) => sample.heapTotal)),
    heapUsed: metricMedian(samples.map((sample) => sample.heapUsed)),
    external: metricMedian(samples.map((sample) => sample.external)),
    arrayBuffers: metricMedian(samples.map((sample) => sample.arrayBuffers)),
    totalHeapSize: metricMedian(samples.map((sample) => sample.totalHeapSize)),
    usedHeapSize: metricMedian(samples.map((sample) => sample.usedHeapSize)),
    totalAvailableSize: metricMedian(
      samples.map((sample) => sample.totalAvailableSize),
    ),
    mallocedMemory: metricMedian(
      samples.map((sample) => sample.mallocedMemory),
    ),
    peakMallocedMemory: metricMedian(
      samples.map((sample) => sample.peakMallocedMemory),
    ),
  };
}

async function runScenario(
  scenario: Scenario,
  runIndex: number,
  snapshotScenario: string | null,
): Promise<MeasurementResult> {
  const childArgs = [
    "--expose-gc",
    "--import",
    "tsx",
    "--env-file-if-exists=.env",
    "scripts/measure-memory-child.ts",
    scenario.mode,
    scenario.target,
    String(scenario.stabilizeMs ?? 1000),
  ];

  const env = {
    ...process.env,
    ...scenario.env,
  };

  if (snapshotScenario === scenario.id && runIndex === 0) {
    env.MEMORY_SNAPSHOT_PATH = `tmp/${scenario.id}.heapsnapshot`;
  }

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, childArgs, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const match = stdout.match(/MEMORY_RESULT:(\{.*\})/s);
      if (code !== 0 || match == null) {
        reject(
          new Error(
            `Scenario ${scenario.id} failed (code ${code}).\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      resolve(JSON.parse(match[1]) as MeasurementResult);
    });
  });
}

function formatMiB(bytes: number): string {
  return `${(bytes / MIB).toFixed(1)} MiB`;
}

const { repeats, filter, snapshotScenario } = parseArgs();

const selectedScenarios = scenarios.filter((scenario) =>
  filter == null ? true : scenario.id.includes(filter),
);

if (selectedScenarios.length < 1) {
  throw new Error(`No scenarios matched filter: ${filter}`);
}

if (snapshotScenario != null) {
  await mkdir("tmp", { recursive: true });
}

const summaries: ScenarioSummary[] = [];

for (const scenario of selectedScenarios) {
  const results: MeasurementResult[] = [];
  for (let runIndex = 0; runIndex < repeats; runIndex += 1) {
    results.push(await runScenario(scenario, runIndex, snapshotScenario));
  }

  summaries.push({
    id: scenario.id,
    mode: scenario.mode,
    target: scenario.target,
    runs: results.length,
    medianAfter: sampleMedian(results.map((result) => result.after)),
    medianDelta: sampleMedian(results.map((result) => result.delta)),
  });
}

console.log(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      node: process.version,
      packageVersion: metadata.version,
      repeats,
      summaries,
    },
    null,
    2,
  ),
);

console.log("\nSummary:");
for (const summary of summaries) {
  console.log(
    [
      `${summary.id} (${summary.mode})`,
      `after rss=${formatMiB(summary.medianAfter.rss)}`,
      `after heapUsed=${formatMiB(summary.medianAfter.heapUsed)}`,
      `delta rss=${formatMiB(summary.medianDelta.rss)}`,
      `delta heapUsed=${formatMiB(summary.medianDelta.heapUsed)}`,
      `delta external=${formatMiB(summary.medianDelta.external)}`,
    ].join(" | "),
  );
}
