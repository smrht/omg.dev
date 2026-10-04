import { describe, expect, test } from "bun:test";
import { cmdUpdate, safeUpdateGateError } from "./update.ts";

// Waarom deze test bestaat: op 27-08-2026 verving een kale bundleswap deze
// install van 0.6.14 naar 0.6.16 en viel de lokale patchlaag eraf — apply.sh
// weigerde op zijn versiepoort, de `-` in de systemd-drop-in liet omg gewoon
// starten, en de box draaide een uur zonder roster-classificatie en zonder de
// eigen MCP-tools. De gate stuurt elke echte update door de veilige route, die
// wél een snapshot, apply.sh en een rollback heeft.

describe("safe-update gate", () => {
  test("een echte update zonder sleutel wordt geweigerd, met de route erbij", () => {
    const message = safeUpdateGateError({}, false);
    expect(message).toContain("omg-safe-update --apply");
    expect(message).toContain("omg-safe-update --check");
  });

  test("alleen de exacte sleutel opent de gate", () => {
    expect(safeUpdateGateError({ OMG_SAFE_UPDATE: "1" }, false)).toBeNull();
    // Alles wat er "waar genoeg" uitziet telt niet: een halve vlag is een
    // vergissing, geen toestemming.
    for (const value of ["0", "", "true", "yes", "on"]) {
      expect(safeUpdateGateError({ OMG_SAFE_UPDATE: value }, false)).not.toBeNull();
    }
  });

  test("--check blijft vrij, met of zonder sleutel", () => {
    expect(safeUpdateGateError({}, true)).toBeNull();
    expect(safeUpdateGateError({ OMG_SAFE_UPDATE: "1" }, true)).toBeNull();
  });

  test("cmdUpdate gebruikt de gate ook echt", async () => {
    const saved = process.env.OMG_SAFE_UPDATE;
    delete process.env.OMG_SAFE_UPDATE;
    try {
      await expect(
        cmdUpdate([], {
          root: "/nonexistent",
          install: { channel: "release" } as ReturnType<typeof import("../config.ts").installInfo>,
          output: () => {},
        }),
      ).rejects.toThrow(/omg-safe-update --apply/);
    } finally {
      if (saved !== undefined) process.env.OMG_SAFE_UPDATE = saved;
    }
  });

  test("een niet-updatebaar kanaal houdt zijn eigen, duidelijkere melding", async () => {
    const saved = process.env.OMG_SAFE_UPDATE;
    delete process.env.OMG_SAFE_UPDATE;
    try {
      await expect(
        cmdUpdate([], {
          root: "/nonexistent",
          install: { channel: "container" } as ReturnType<typeof import("../config.ts").installInfo>,
          output: () => {},
        }),
      ).rejects.toThrow(/container install/);
    } finally {
      if (saved !== undefined) process.env.OMG_SAFE_UPDATE = saved;
    }
  });
});
