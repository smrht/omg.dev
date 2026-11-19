import { expect, test } from "bun:test";
import { AUTO_AGENT_BACKENDS } from "../../agent-catalog.ts";
import { AGENT_CATALOG } from "../../../web/src/lib/coding-agent-options.ts";
import { antigravityOneShotSink } from "./antigravity-oneshot.ts";

test("antigravity can run as a scheduled auto agent", () => {
  expect(AUTO_AGENT_BACKENDS).toContain("antigravity");
  expect(AGENT_CATALOG.find((e) => e.key === "antigravity")?.scheduled).toBe(true);
});

test("one-shot sink keeps narration segments apart and cancels questions", async () => {
  const logs: string[] = [];
  const sink = antigravityOneShotSink((s) => logs.push(s));
  sink.commitText("Ik kijk eerst in de logs.");
  sink.commitText("   ");
  sink.toolStart("1", "run_command");
  sink.commitText("Gevonden.");
  expect(sink.segments).toEqual(["Ik kijk eerst in de logs.", "Gevonden."]);
  expect(await sink.ask("Mag ik?", [], "x")).toBeNull();
  expect(logs.some((l) => l.includes("run_command"))).toBe(true);
});

test("a backgrounded tool keeps the one-shot waiting until it ends and the stream is quiet", async () => {
  const { antigravityStillWorking } = await import("./antigravity-oneshot.ts");
  let t = 1000;
  const sink = antigravityOneShotSink(() => {}, () => t);
  sink.toolStart("call-1", "run_command");
  t = 100_000;
  expect(antigravityStillWorking(sink, t, 20_000)).toBe(true); // tool open, however long
  sink.toolEnd("call-1", "run_command", { output: "KLAAR" });
  expect(antigravityStillWorking(sink, t + 5_000, 20_000)).toBe(true); // just ended: continuation may follow
  expect(antigravityStillWorking(sink, t + 21_000, 20_000)).toBe(false);
});
