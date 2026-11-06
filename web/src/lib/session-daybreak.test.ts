import { describe, expect, mock, test } from "bun:test";
import {
  AUTOMATIC_PROGRAM_LABEL,
  CYBER_ACCESS_PROGRAMS,
  cyberAccessProgramsFor,
  daybreakLabel,
  offersDaybreak,
  parseCyberAccessProgram,
  resolveLaunchProgram,
  setSessionCyberAccessProgram,
} from "./session-daybreak";

const catalog = (capabilities: Record<string, { cyberAccessPrograms?: string[] }>) => ({
  modelCapabilities: { "codex-aisdk": capabilities },
});

describe("parseCyberAccessProgram", () => {
  test("accepts exactly the three wire values", () => {
    expect(CYBER_ACCESS_PROGRAMS).toEqual(["standard", "daybreakBlue", "daybreakRed"]);
    expect(parseCyberAccessProgram("standard")).toBe("standard");
    expect(parseCyberAccessProgram("daybreakBlue")).toBe("daybreakBlue");
    expect(parseCyberAccessProgram("daybreakRed")).toBe("daybreakRed");
  });

  test("rejects everything else without throwing", () => {
    expect(parseCyberAccessProgram("daybreak")).toBeNull();
    expect(parseCyberAccessProgram("")).toBeNull();
    expect(parseCyberAccessProgram(null)).toBeNull();
    expect(parseCyberAccessProgram(undefined)).toBeNull();
    expect(parseCyberAccessProgram(7)).toBeNull();
  });
});

describe("daybreakLabel", () => {
  test("maps wire values to the pill vocabulary", () => {
    expect(daybreakLabel("standard")).toBe("Uit");
    expect(daybreakLabel("daybreakBlue")).toBe("Blue");
    expect(daybreakLabel("daybreakRed")).toBe("Red");
    expect(daybreakLabel(null)).toBe(AUTOMATIC_PROGRAM_LABEL);
    expect(daybreakLabel(undefined)).toBe(AUTOMATIC_PROGRAM_LABEL);
    expect(daybreakLabel("nonsense")).toBe(AUTOMATIC_PROGRAM_LABEL);
  });
});

describe("cyberAccessProgramsFor", () => {
  test("only the codex-aisdk backend gets a vocabulary", () => {
    const caps = catalog({ "gpt-6-sol": { cyberAccessPrograms: ["standard", "daybreakBlue"] } });
    expect(cyberAccessProgramsFor(caps, "codex-aisdk", "gpt-6-sol")).toEqual(["standard", "daybreakBlue"]);
    expect(cyberAccessProgramsFor(caps, "codex", "gpt-6-sol")).toEqual([]);
    expect(cyberAccessProgramsFor(caps, "claude", "sonnet")).toEqual([]);
    expect(cyberAccessProgramsFor(caps, undefined, "gpt-6-sol")).toEqual([]);
  });

  test("normalizes to the fixed display order and drops unknown values", () => {
    const caps = catalog({
      "gpt-6-sol": { cyberAccessPrograms: ["daybreakRed", "standard", "daybreakNeon"] },
    });
    expect(cyberAccessProgramsFor(caps, "codex-aisdk", "gpt-6-sol")).toEqual(["standard", "daybreakRed"]);
  });

  test("an unknown model or missing metadata offers nothing", () => {
    const caps = catalog({ "gpt-6-sol": { cyberAccessPrograms: ["standard", "daybreakBlue"] } });
    expect(cyberAccessProgramsFor(caps, "codex-aisdk", "gpt-6-astra")).toEqual([]);
    expect(cyberAccessProgramsFor(caps, "codex-aisdk", undefined)).toEqual([]);
    expect(cyberAccessProgramsFor(null, "codex-aisdk", "gpt-6-sol")).toEqual([]);
    expect(cyberAccessProgramsFor({}, "codex-aisdk", "gpt-6-sol")).toEqual([]);
  });
});

describe("offersDaybreak", () => {
  test("needs a nonstandard program; plain standard is not a control", () => {
    expect(offersDaybreak(["standard"])).toBe(false);
    expect(offersDaybreak([])).toBe(false);
    expect(offersDaybreak(["standard", "daybreakBlue"])).toBe(true);
    expect(offersDaybreak(["daybreakRed"])).toBe(true);
  });
});

describe("resolveLaunchProgram", () => {
  test("keeps a choice the launch model still offers", () => {
    expect(resolveLaunchProgram("daybreakBlue", ["standard", "daybreakBlue"])).toBe("daybreakBlue");
  });

  test("drops a stale choice and passes null through", () => {
    expect(resolveLaunchProgram("daybreakBlue", ["standard"])).toBeNull();
    expect(resolveLaunchProgram("daybreakBlue", [])).toBeNull();
    expect(resolveLaunchProgram(null, ["standard", "daybreakBlue"])).toBeNull();
  });
});

describe("setSessionCyberAccessProgram", () => {
  test("POSTs the explicit program to the per-session endpoint", async () => {
    const request = mock(async (_path: string, _init?: RequestInit) => ({}));
    await setSessionCyberAccessProgram("sess one", "daybreakRed", request);
    expect(request.mock.calls).toHaveLength(1);
    const [path, init] = request.mock.calls[0]!;
    expect(path).toBe("/api/sessions/sess%20one/cyber-access-program");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ cyberAccessProgram: "daybreakRed" });
  });
});
