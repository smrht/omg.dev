import type { CollectorResult } from "./index.ts";

async function runGh(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawnSync({
    cmd: ["gh", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });
  return {
    ok: proc.exitCode === 0,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

export async function collectGithubIssues(spec: {
  kind: "github_issues";
  repo: string;
  state?: string;
  limit?: number;
}): Promise<CollectorResult> {
  const limit = spec.limit ?? 50;
  const state = spec.state ?? "open";
  const r = await runGh([
    "issue",
    "list",
    "-R",
    spec.repo,
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    "number,title,state,labels,author,createdAt,updatedAt,comments,url",
  ]);
  if (!r.ok) {
    return {
      title: `GitHub issues — ${spec.repo}`,
      body: `(gh failed: ${r.err.slice(0, 500)})`,
      ok: false,
      warning: r.err,
    };
  }
  return {
    title: `GitHub issues — ${spec.repo} (state=${state}, limit ${limit})`,
    body: "```json\n" + r.out + "\n```",
    ok: true,
  };
}

export async function collectGithubPrs(spec: {
  kind: "github_prs";
  repo: string;
  state?: string;
  limit?: number;
}): Promise<CollectorResult> {
  const limit = spec.limit ?? 50;
  const state = spec.state ?? "open";
  const r = await runGh([
    "pr",
    "list",
    "-R",
    spec.repo,
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    "number,title,state,labels,author,createdAt,updatedAt,url,isDraft,reviews",
  ]);
  if (!r.ok) {
    return {
      title: `GitHub PRs — ${spec.repo}`,
      body: `(gh failed: ${r.err.slice(0, 500)})`,
      ok: false,
      warning: r.err,
    };
  }
  return {
    title: `GitHub PRs — ${spec.repo} (state=${state}, limit ${limit})`,
    body: "```json\n" + r.out + "\n```",
    ok: true,
  };
}
