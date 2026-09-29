import { runSelectedBackendUncontained } from "./auto/runner.ts";
if (import.meta.main) {
  let logCount = 0;
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  const log = (s: string) => {
    if (logCount++ < 200) process.stdout.write("OMG_ISOLATION_LOG " + JSON.stringify(s) + "\n");
  };
  try {
    const { agent, prompt, cwd, mode, completion } = JSON.parse(await Bun.stdin.text());
    if (mode === "chat") {
      // A chat reply's failure is shown in the thread, so its reason travels
      // in the result packet, trimmed and redacted. The generic catch below
      // stays silent on purpose: provider exceptions can carry credentials or
      // full prompts, and only this path owns the message it emits.
      const { dispatchThreadCompletion, visibleCompletionError } = await import("./thread-completion.ts");
      try {
        // contained lives in the DEPS argument: this IS the isolation worker,
        // so the dispatch must stay local instead of spawning another one.
        const result = await dispatchThreadCompletion(completion, { contained: true });
        process.stdout.write("\nOMG_ISOLATION_RESULT " + JSON.stringify({ result }) + "\n");
      } catch (error) {
        process.stdout.write(
          "\nOMG_ISOLATION_RESULT " + JSON.stringify({ error: visibleCompletionError(error, "the reply failed") }) + "\n",
        );
        process.exitCode = 1;
      }
    } else {
      const result = mode === "enhance"
        ? await (await import("./auto/enhance.ts")).generateUncontained(prompt, agent.cwd, log)
        : mode === "report"
        ? await (await import("./agents/runner.ts")).pipeToClaudeUncontained(prompt, log, agent.backend, agent.model)
        : await runSelectedBackendUncontained(agent, prompt, cwd, log);
      process.stdout.write("\nOMG_ISOLATION_RESULT " + JSON.stringify({ result }) + "\n");
    }
  } catch {
    // Provider exceptions can contain credentials or full prompts.
    process.stderr.write("Isolated backend failed\n");
    process.exitCode = 1;
  }
}
