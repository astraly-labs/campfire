import { Command, GlobalFlag } from "effect/cli";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ServerConfig } from "../config.ts";
import {
  createLocalCodexAdapterV2,
  layerAppServerClientFactory,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  startCodexProviderHostServer,
  type HostedCodexAdapter,
} from "../provider/host/CodexProviderHost.ts";
import { resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

export class CodexProviderHostStartupError extends Schema.TaggedError<CodexProviderHostStartupError>()(
  "CodexProviderHostStartupError",
  { cause: Schema.Defect() },
) {}

export const runCodexProviderHost = Effect.fn("runCodexProviderHost")(function* (
  config: ServerConfig["Service"],
  socketPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const context = yield* Effect.context<
    | Effect.Services<ReturnType<typeof createLocalCodexAdapterV2>>
    | McpProviderSessions.McpProviderSessions
  >();
  const runPromise = Effect.runPromiseWith(context);
  const mcp = yield* McpProviderSessions.McpProviderSessions;
  const host = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        startCodexProviderHostServer({
          socketPath,
          createAdapter: async (input, hooks): Promise<HostedCodexAdapter> => {
            const scope = await runPromise(Scope.make());
            const configuration = {
              ...input,
              enabled: input.config.enabled,
              displayName: "Codex",
              accentColor: undefined,
            };
            const continuation = { offer: hooks.continuation, take: Effect.never };
            const make = (
              resolveRuntime?: NonNullable<
                Parameters<typeof createLocalCodexAdapterV2>[1]
              >["resolveRuntime"],
            ) =>
              createLocalCodexAdapterV2(configuration, {
                onUsageLimits: hooks.usage,
                ...(resolveRuntime === undefined ? {} : { resolveRuntime }),
              }).pipe(
                Effect.provideService(
                  ProviderContinuationRequests.ProviderContinuationRequests,
                  continuation,
                ),
              );
            const adapter = await runPromise(
              make().pipe(Effect.provideService(Scope.Scope, scope)),
            );
            return {
              adapter,
              setMcpSessions: (sessions) =>
                runPromise(
                  Effect.forEach(
                    sessions,
                    ({ capabilities, ...session }) =>
                      mcp.set({
                        ...session,
                        ...(capabilities === undefined
                          ? {}
                          : { capabilities: new Set(capabilities) }),
                      }),
                    { discard: true },
                  ),
                ),
              openSession: (input, runtime, sessionScope) =>
                runPromise(
                  Effect.gen(function* () {
                    const local =
                      runtime === undefined ? adapter : yield* make(Effect.succeed(runtime));
                    return yield* local.openSession(input);
                  }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
                ),
              close: () => runPromise(Scope.close(scope, Exit.void)),
            };
          },
          prepareSocket: () =>
            runPromise(
              fs
                .makeDirectory(path.dirname(socketPath), { recursive: true })
                .pipe(Effect.andThen(fs.remove(socketPath, { force: true }))),
            ),
          secureSocket: () => runPromise(fs.chmod(socketPath, 0o600)),
          cleanupSocket: () => runPromise(fs.remove(socketPath, { force: true })),
        }),
      catch: (cause) => new CodexProviderHostStartupError({ cause }),
    }),
    (host) => Effect.promise(() => host.close()),
  );
  yield* Effect.logInfo("[🔌 Provider host] Codex runtimes are hosted independently.", {
    socketPath: host.socketPath,
    baseDir: config.baseDir,
  });
  return yield* Effect.never;
});

const layerHost = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerAppServerClientFactory.pipe(
    Layer.provide(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  ),
);
export const providerHostCommand = Command.make("provider-host", {
  ...sharedServerCommandFlags,
}).pipe(
  Command.withDescription("Keep Codex runtimes alive across T3 server restarts."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const logLevel = yield* GlobalFlag.LogLevel;
      const config = yield* resolveServerConfig(flags, logLevel, {
        startupPresentation: "headless",
        forceAutoBootstrapProjectFromCwd: false,
      });
      const path = yield* Path.Path;
      const socketPath =
        config.providerHostSocketPath ??
        path.join(config.baseDir, "runtime", "codex-provider-host.sock");
      return yield* runCodexProviderHost(config, socketPath).pipe(
        Effect.provide(layerHost),
        Effect.provideService(ServerConfig, config),
      );
    }),
  ),
);
