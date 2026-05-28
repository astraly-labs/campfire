import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { describe, expect } from "vitest";

import {
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { ProviderInstanceRegistryShape } from "../provider/Services/ProviderInstanceRegistry.ts";
import type { TextGenerationShape } from "./TextGeneration.ts";

import { makeTextGenerationFromRegistry } from "./TextGeneration.ts";

const makeStubTextGeneration = (overrides: Partial<TextGenerationShape>): TextGenerationShape => ({
  generateCommitMessage: () =>
    Effect.die("generateCommitMessage stub not configured for this test"),
  generatePrContent: () => Effect.die("generatePrContent stub not configured for this test"),
  generateBranchName: () => Effect.die("generateBranchName stub not configured for this test"),
  generateThreadTitle: () => Effect.die("generateThreadTitle stub not configured for this test"),
  generateThreadHandoff: () =>
    Effect.die("generateThreadHandoff stub not configured for this test"),
  generateConversationSummary: () =>
    Effect.die("generateConversationSummary stub not configured for this test"),
  ...overrides,
});

interface StubInstanceOptions {
  /** Auth status reported by the instance snapshot. Defaults to authenticated. */
  readonly authStatus?: "authenticated" | "unauthenticated" | "unknown";
  /** Availability reported by the instance snapshot. Defaults to available. */
  readonly availability?: "available" | "unavailable";
  /** Driver kind slug. Defaults to the instanceId; use "codex" to test ordering. */
  readonly driverKind?: string;
}

const makeStubInstance = (
  instanceId: ProviderInstanceId,
  textGeneration: TextGenerationShape,
  options: StubInstanceOptions = {},
): ProviderInstance => {
  const driverKind = (options.driverKind ??
    instanceId) as unknown as ProviderInstance["driverKind"];
  // Our fallback resolution only reads `auth.status` and `availability` off the
  // snapshot, so a minimal object is enough.
  const snapshot = {
    getSnapshot: Effect.succeed({
      auth: { status: options.authStatus ?? "authenticated" },
      availability: options.availability ?? "available",
    } as unknown as ServerProvider),
  } as unknown as ProviderInstance["snapshot"];
  return {
    instanceId,
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `${instanceId}:test`,
    },
    displayName: undefined,
    enabled: true,
    snapshot,
    adapter: {} as ProviderInstance["adapter"],
    textGeneration,
  } satisfies ProviderInstance;
};

const makeStubRegistry = (
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceRegistryShape => {
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance] as const));
  return {
    getInstance: (id) => Effect.succeed(byId.get(id)),
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    streamChanges: Stream.empty,
    // Tests never drive changes through this stub; acquire a throwaway
    // subscription on an unused PubSub so the shape is satisfied.
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
      PubSub.subscribe(pubsub),
    ),
  };
};

const commitInput = (modelSelection: ModelSelection) => ({
  cwd: process.cwd(),
  branch: null,
  stagedSummary: "summary",
  stagedPatch: "patch",
  modelSelection,
});

describe("makeTextGenerationFromRegistry", () => {
  it.effect("delegates to the matching instance's textGeneration closure", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const personalCalls: string[] = [];
      const personal = makeStubInstance(
        personalId,
        makeStubTextGeneration({
          generateBranchName: (input) => {
            personalCalls.push(input.message);
            return Effect.succeed({ branch: "personal-branch" });
          },
        }),
      );

      const workId = ProviderInstanceId.make("codex_work");
      const work = makeStubInstance(
        workId,
        makeStubTextGeneration({
          generateBranchName: () => Effect.succeed({ branch: "work-branch" }),
        }),
      );

      const tg = makeTextGenerationFromRegistry(makeStubRegistry([personal, work]));

      const result = yield* tg.generateBranchName({
        cwd: process.cwd(),
        message: "Refactor the routing layer",
        modelSelection: createModelSelection(ProviderInstanceId.make("codex_personal"), "gpt-5"),
      });

      expect(result.branch).toBe("personal-branch");
      expect(personalCalls).toEqual(["Refactor the routing layer"]);
    }),
  );

  it.effect("fails with TextGenerationError when the instance is unknown", () =>
    Effect.gen(function* () {
      const tg = makeTextGenerationFromRegistry(makeStubRegistry([]));

      const result = yield* tg
        .generateBranchName({
          cwd: process.cwd(),
          message: "anything",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("missing_instance"),
            "gpt-5",
          ),
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("TextGenerationError");
        expect(result.failure.operation).toBe("generateBranchName");
        expect(result.failure.detail).toContain("missing_instance");
      }
    }),
  );

  it.effect(
    "falls back to an authenticated provider when the configured one is unauthenticated",
    () =>
      Effect.gen(function* () {
        const claudeId = ProviderInstanceId.make("claude_x");
        const claudeCalls: string[] = [];
        const claude = makeStubInstance(
          claudeId,
          makeStubTextGeneration({
            generateCommitMessage: (input) => {
              claudeCalls.push(input.stagedSummary);
              return Effect.succeed({ subject: "from claude", body: "" });
            },
          }),
          { authStatus: "unauthenticated", driverKind: "claudeAgent" },
        );

        const codexId = ProviderInstanceId.make("codex_x");
        const codexReceived: ModelSelection[] = [];
        const codex = makeStubInstance(
          codexId,
          makeStubTextGeneration({
            generateCommitMessage: (input) => {
              codexReceived.push(input.modelSelection);
              return Effect.succeed({ subject: "from codex", body: "via codex" });
            },
          }),
          { authStatus: "authenticated", driverKind: "codex" },
        );

        const tg = makeTextGenerationFromRegistry(makeStubRegistry([claude, codex]));
        const result = yield* tg.generateCommitMessage(
          commitInput(createModelSelection(claudeId, "claude-haiku-4-5")),
        );

        expect(result.subject).toBe("from codex");
        // The unauthenticated instance is skipped up front — never invoked.
        expect(claudeCalls).toEqual([]);
        // The fallback selection is rewritten to the Codex default text-gen model.
        expect(codexReceived[0]?.instanceId).toBe(codexId);
        expect(codexReceived[0]?.model).toBe("gpt-5.4-mini");
      }),
  );

  it.effect(
    "retries an authenticated fallback when the configured provider fails at call time",
    () =>
      Effect.gen(function* () {
        const primaryId = ProviderInstanceId.make("primary_x");
        const primary = makeStubInstance(
          primaryId,
          makeStubTextGeneration({
            generateCommitMessage: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "generateCommitMessage",
                  detail: "API Error: 401 Invalid authentication",
                }),
              ),
          }),
          { authStatus: "authenticated", driverKind: "claudeAgent" },
        );

        const codexId = ProviderInstanceId.make("codex_x");
        const codex = makeStubInstance(
          codexId,
          makeStubTextGeneration({
            generateCommitMessage: () => Effect.succeed({ subject: "from codex", body: "" }),
          }),
          { authStatus: "authenticated", driverKind: "codex" },
        );

        const tg = makeTextGenerationFromRegistry(makeStubRegistry([primary, codex]));
        const result = yield* tg.generateCommitMessage(
          commitInput(createModelSelection(primaryId, "claude-haiku-4-5")),
        );

        expect(result.subject).toBe("from codex");
      }),
  );

  it.effect(
    "surfaces the configured provider's own error when no authenticated fallback exists",
    () =>
      Effect.gen(function* () {
        const onlyId = ProviderInstanceId.make("only_x");
        const only = makeStubInstance(
          onlyId,
          makeStubTextGeneration({
            generateCommitMessage: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: "generateCommitMessage",
                  detail: "401 from configured provider",
                }),
              ),
          }),
          { authStatus: "unauthenticated", driverKind: "claudeAgent" },
        );

        const tg = makeTextGenerationFromRegistry(makeStubRegistry([only]));
        const result = yield* tg
          .generateCommitMessage(commitInput(createModelSelection(onlyId, "claude-haiku-4-5")))
          .pipe(Effect.result);

        expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          expect(result.failure.detail).toContain("401 from configured provider");
        }
      }),
  );

  it.effect("uses the configured provider unchanged when it is authenticated", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex_x");
      const received: ModelSelection[] = [];
      const codex = makeStubInstance(
        codexId,
        makeStubTextGeneration({
          generateCommitMessage: (input) => {
            received.push(input.modelSelection);
            return Effect.succeed({ subject: "from configured", body: "" });
          },
        }),
        { authStatus: "authenticated", driverKind: "codex" },
      );

      const otherId = ProviderInstanceId.make("codex_other");
      const otherCalls: number[] = [];
      const other = makeStubInstance(
        otherId,
        makeStubTextGeneration({
          generateCommitMessage: () => {
            otherCalls.push(1);
            return Effect.succeed({ subject: "from other", body: "" });
          },
        }),
        { authStatus: "authenticated", driverKind: "codex" },
      );

      const tg = makeTextGenerationFromRegistry(makeStubRegistry([codex, other]));
      const result = yield* tg.generateCommitMessage(
        commitInput(createModelSelection(codexId, "gpt-5.4")),
      );

      expect(result.subject).toBe("from configured");
      // Original model is preserved (not rewritten) and no fallback is invoked.
      expect(received[0]?.model).toBe("gpt-5.4");
      expect(otherCalls).toEqual([]);
    }),
  );
});
