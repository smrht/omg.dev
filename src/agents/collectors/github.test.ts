import { afterEach, describe, expect, test } from "bun:test";
import { collectGithubPrs } from "./github.ts";

const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
});

describe("GitHub PR collector", () => {
  test("requests and preserves review data", async () => {
    const dir = await Bun.$`mktemp -d`.text();
    const bin = `${dir.trim()}/gh`;
    await Bun.write(bin, `#!/bin/sh
printf '%s\\n' '[{"number":42,"title":"Fresh","reviews":[{"author":{"login":"sam"},"state":"APPROVED","submittedAt":"2026-08-28T08:00:00Z"}]}]'
`);
    await Bun.$`chmod +x ${bin}`;
    process.env.PATH = `${dir.trim()}:${originalPath ?? ""}`;

    const result = await collectGithubPrs({ kind: "github_prs", repo: "smrht/omg.dev" });
    expect(result.ok).toBe(true);
    expect(result.body).toContain('"reviews"');
    expect(result.body).toContain('2026-08-28T08:00:00Z');
  });
});
