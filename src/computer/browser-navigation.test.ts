import { describe, expect, test } from "bun:test";
import { navigateWithRecovery } from "./browser.ts";

describe("navigateWithRecovery", () => {
  test("times out a navigation that never settles and invokes recovery once", async () => {
    let recoveries = 0;
    const view = {
      navigate: () => new Promise<void>(() => {}),
    };

    await expect(
      navigateWithRecovery(view, "https://example.com", {
        timeoutMs: 5,
        recover: () => {
          recoveries += 1;
        },
      }),
    ).rejects.toThrow("browser navigation timed out after 5ms");
    expect(recoveries).toBe(1);
  });

  test("does not invoke recovery when navigation finishes", async () => {
    let recoveries = 0;
    const view = {
      navigate: async () => {},
    };

    await navigateWithRecovery(view, "https://example.com", {
      timeoutMs: 50,
      recover: () => {
        recoveries += 1;
      },
    });
    expect(recoveries).toBe(0);
  });
});
