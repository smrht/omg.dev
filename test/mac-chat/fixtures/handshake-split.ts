// Fixture: ssh stream stand-in that answers the ready handshake in the
// EXACT split+coalesced shape the primary probed live (item 33): the first
// 20 handshake bytes arrive as their own chunk, then — after a pause that
// guarantees the reader sees two chunks — the remaining header, the newline
// AND 64 KiB of native payload land in ONE write. A client that slices the
// second chunk by the CUMULATIVE handshake length drops the whole payload.
// The payload is a deterministic pattern (byte i = (i*7+13) % 256) so the
// test rebuilds it byte-for-byte and compares SHA + content. The process
// stays alive (stdin drained) until the parent kills it.
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const outDir = process.env.FIXTURE_OUT;
const argv = process.argv.slice(2);
const verbIndex = argv.findIndex((a) => a === "stream");

function log(name: string, data: unknown): void {
  if (!outDir) return;
  mkdirSync(outDir, { recursive: true });
  appendFileSync(join(outDir, name), `${JSON.stringify(data)}\n`);
}

if (verbIndex < 0) {
  process.stderr.write("handshake-split fixture: no stream verb\n");
  process.exit(2);
}

// Read the metadata line (first stdin chunk carries it).
const firstChunk: Buffer = await new Promise((resolve) => {
  process.stdin.once("data", (d: Buffer) => resolve(d));
  process.stdin.once("end", () => resolve(Buffer.alloc(0)));
  process.stdin.resume();
});
let requestId: string | null = null;
try {
  const nl = firstChunk.indexOf(0x0a);
  const line = firstChunk.subarray(0, nl >= 0 ? nl : firstChunk.byteLength).toString("utf8");
  requestId = (JSON.parse(line) as { requestId?: string }).requestId ?? null;
} catch {
  requestId = null;
}

const header = Buffer.from(
  `{"transport":1,"requestId":${JSON.stringify(requestId)},"status":"ready","pid":${process.pid}}`,
  "utf8",
);
const SPLIT_AT = 20;
const payload = Buffer.alloc(64 * 1024);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 13) % 256;

const part1 = header.subarray(0, SPLIT_AT);
const part2 = Buffer.concat([header.subarray(SPLIT_AT), Buffer.from("\n", "utf8"), payload]);

// Chunk 1: the first 20 header bytes alone.
process.stdout.write(part1);
await new Promise((resolve) => setTimeout(resolve, 120));
// Chunk 2: header tail + newline + the ENTIRE native payload in one write.
process.stdout.write(part2);
log("split-handshake.json", {
  headerBytes: header.byteLength,
  splitAt: SPLIT_AT,
  payloadBytes: payload.byteLength,
});

// Keep the stream open; drain stdin until the parent kills us.
process.stdin.on("data", () => {});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
