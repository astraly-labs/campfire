import { assert, describe, it } from "@effect/vitest";
import * as CodexSchema from "effect-codex-app-server/schema";

import { parseCodexSkillsListResponse } from "./CodexProvider.ts";

// `V2SkillsListResponse` carries a `data` array of `{ cwd, skills }` entries.
// We construct the minimum shape the parser reads, casting through `unknown`
// to bypass the generated schema's optional fields that we don't exercise.
const makeResponse = (
  skills: ReadonlyArray<{
    readonly name: string;
    readonly path: string;
    readonly enabled: boolean;
    readonly description?: string;
    readonly scope?: string;
  }>,
  cwd = "/repo",
): CodexSchema.V2SkillsListResponse =>
  ({
    data: [{ cwd, skills }],
  }) as unknown as CodexSchema.V2SkillsListResponse;

describe("parseCodexSkillsListResponse", () => {
  it("returns enabled skills as-is when the disabled set is empty", () => {
    const skills = parseCodexSkillsListResponse(
      makeResponse([
        { name: "browser", path: "/Users/x/.codex/skills/browser/SKILL.md", enabled: true },
        { name: "deploy", path: "/Users/x/.codex/skills/deploy/SKILL.md", enabled: true },
      ]),
      "/repo",
      new Set(),
    );

    assert.deepStrictEqual(
      skills.map((s) => ({ name: s.name, enabled: s.enabled })),
      [
        { name: "browser", enabled: true },
        { name: "deploy", enabled: true },
      ],
    );
  });

  it("forces enabled=false for skills whose names appear in the disabled set", () => {
    const skills = parseCodexSkillsListResponse(
      makeResponse([
        { name: "browser", path: "/p/browser/SKILL.md", enabled: true },
        { name: "deploy", path: "/p/deploy/SKILL.md", enabled: true },
        { name: "ci-debug", path: "/p/ci-debug/SKILL.md", enabled: true },
      ]),
      "/repo",
      new Set(["deploy", "ci-debug"]),
    );

    assert.deepStrictEqual(
      skills.map((s) => ({ name: s.name, enabled: s.enabled })),
      [
        { name: "browser", enabled: true },
        { name: "deploy", enabled: false },
        { name: "ci-debug", enabled: false },
      ],
    );
  });

  it("preserves the upstream enabled=false even when the skill is not in the disabled set", () => {
    // The override is additive: if Codex already disabled the skill upstream,
    // we keep it disabled. Our override only ever flips enabled true → false,
    // never the other way around.
    const skills = parseCodexSkillsListResponse(
      makeResponse([{ name: "stale", path: "/p/stale/SKILL.md", enabled: false }]),
      "/repo",
      new Set(),
    );

    assert.strictEqual(skills[0]?.enabled, false);
  });

  it("carries over description and scope when present", () => {
    const skills = parseCodexSkillsListResponse(
      makeResponse([
        {
          name: "browser",
          path: "/p/browser/SKILL.md",
          enabled: true,
          description: "Browser lets Codex open and control the in-app browser",
          scope: "user",
        },
      ]),
      "/repo",
      new Set(),
    );

    assert.strictEqual(
      skills[0]?.description,
      "Browser lets Codex open and control the in-app browser",
    );
    assert.strictEqual(skills[0]?.scope, "user");
  });
});
