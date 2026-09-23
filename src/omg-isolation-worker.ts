import { runSelectedBackendUncontained } from "./auto/runner.ts";
if (import.meta.main) {
  try {
    const { agent, prompt, cwd, mode } = JSON.parse(await Bun.stdin.text());
    let logCount = 0;
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    console.error = () => {};
    const log = (s: string) => {
      if (logCount++ < 200) process.stdout.write("OMG_ISOLATION_LOG " + JSON.stringify(s) + "\n");
    };
    const result = mode === "enhance"
      ? await (await import("./auto/enhance.ts")).generateUncontained(prompt, agent.cwd, log)
      : mode === "report"
      ? await (await import("./agents/runner.ts")).pipeToClaudeUncontained(prompt, log, agent.backend, agent.model)
      : await runSelectedBackendUncontained(agent, prompt, cwd, log);
    process.stdout.write("\nOMG_ISOLATION_RESULT " + JSON.stringify({ result }) + "\n");
  } catch {
    // Provider exceptions can contain credentials or full prompts.
    process.stderr.write("Isolated backend failed\n");
    process.exitCode = 1;
  }
}
