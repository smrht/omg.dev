import { describe, expect, test } from "bun:test";
import { agentboxOwnerName, agentboxProfile, agentboxWebConfig } from "./agentbox-profile.ts";
import { omgRuntimeContract } from "./omg-capabilities.ts";

describe("agentbox profile", () => {
  test("unset is Sam's box, unchanged", () => {
    expect(agentboxProfile({})).toBe("sam");
    expect(agentboxOwnerName({})).toBe("Sam");
    expect(agentboxWebConfig({})).toEqual({ profile: "sam", ownerName: "Sam", taken: true, defaultProject: "sites-beheer" });
  });
  test("neutral drops Taken, the default project and the Sam name", () => {
    const env = { AGENTBOX_PROFILE: "neutral", AGENTBOX_OWNER_NAME: "Albin" };
    expect(agentboxWebConfig(env)).toEqual({ profile: "neutral", ownerName: "Albin", taken: false, defaultProject: null });
    expect(agentboxOwnerName({ AGENTBOX_PROFILE: "neutral" })).toBeNull();
  });
  test("the runtime contract carries Sam's host policy only on his box", () => {
    const prev = process.env.AGENTBOX_PROFILE;
    delete process.env.AGENTBOX_PROFILE;
    const sam = omgRuntimeContract();
    process.env.AGENTBOX_PROFILE = "neutral";
    const neutral = omgRuntimeContract();
    if (prev === undefined) delete process.env.AGENTBOX_PROFILE; else process.env.AGENTBOX_PROFILE = prev;
    expect(sam).toContain("sites-beheer/docs/agentbox/mac-heavy-policy.md");
    for (const s of ["sites-beheer", "agentbox-mac", "samht", "Sam,"]) expect(neutral).not.toContain(s);
    expect(sam.split("\n").length).toBe(neutral.split("\n").length + 1);
  });
});
