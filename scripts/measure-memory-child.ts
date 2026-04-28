import {
  getHeapSpaceStatistics,
  getHeapStatistics,
  writeHeapSnapshot,
} from "node:v8";

interface HeapSpaceMetrics {
  physicalSize: number;
  size: number;
  used: number;
  available: number;
}

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
  heapSpaces: Record<string, HeapSpaceMetrics>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function collectGarbage(): Promise<void> {
  if (global.gc == null) {
    throw new Error("Memory measurements require --expose-gc");
  }

  for (let i = 0; i < 3; i += 1) {
    global.gc();
    await delay(50);
  }
}

async function sampleMemory(): Promise<MemorySample> {
  await collectGarbage();

  const usage = process.memoryUsage();
  const heap = getHeapStatistics();
  const heapSpaces = Object.fromEntries(
    getHeapSpaceStatistics().map((space) => [
      space.space_name,
      {
        physicalSize: space.physical_space_size,
        size: space.space_size,
        used: space.space_used_size,
        available: space.space_available_size,
      },
    ]),
  );

  return {
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    totalHeapSize: heap.total_heap_size,
    usedHeapSize: heap.used_heap_size,
    totalAvailableSize: heap.total_available_size,
    mallocedMemory: heap.malloced_memory,
    peakMallocedMemory: heap.peak_malloced_memory,
    heapSpaces,
  };
}

const [mode, target, stabilizeMsArg = "1000"] = process.argv.slice(2);

if (mode == null || target == null) {
  throw new Error(
    "Usage: measure-memory-child.ts <module|server> <target> [stabilize-ms]",
  );
}

const stabilizeMs = Number.parseInt(stabilizeMsArg, 10);
if (!Number.isFinite(stabilizeMs)) {
  throw new Error(`Invalid stabilize delay: ${stabilizeMsArg}`);
}

const before = await sampleMemory();

if (mode === "module" || mode === "server") {
  await import(target);
} else {
  throw new Error(`Unsupported mode: ${mode}`);
}

await delay(stabilizeMs);
const after = await sampleMemory();

const snapshotPath = process.env.MEMORY_SNAPSHOT_PATH?.trim();
const heapSnapshotPath =
  snapshotPath == null || snapshotPath === ""
    ? null
    : writeHeapSnapshot(snapshotPath);

const result = {
  before,
  after,
  delta: {
    rss: after.rss - before.rss,
    heapTotal: after.heapTotal - before.heapTotal,
    heapUsed: after.heapUsed - before.heapUsed,
    external: after.external - before.external,
    arrayBuffers: after.arrayBuffers - before.arrayBuffers,
    totalHeapSize: after.totalHeapSize - before.totalHeapSize,
    usedHeapSize: after.usedHeapSize - before.usedHeapSize,
    totalAvailableSize: after.totalAvailableSize - before.totalAvailableSize,
    mallocedMemory: after.mallocedMemory - before.mallocedMemory,
    peakMallocedMemory: after.peakMallocedMemory - before.peakMallocedMemory,
  },
  heapSnapshotPath,
};

process.stdout.write(`MEMORY_RESULT:${JSON.stringify(result)}\n`);
process.exit(0);
