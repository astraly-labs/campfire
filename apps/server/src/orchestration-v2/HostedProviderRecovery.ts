import {
  CommandId,
  isOrchestrationV2WorkActive,
  ProviderDriverKind,
  type ThreadId,
  type ProviderSessionId,
  type RunId,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RunExecutionService from "./RunExecutionService.ts";

export interface HostedRecoveryState {
  readonly threadIds: ReadonlySet<ThreadId>;
  readonly sessionIds: ReadonlySet<ProviderSessionId>;
  readonly runIds: ReadonlySet<RunId>;
}
const emptyHostedState = (): HostedRecoveryState => ({
  threadIds: new Set(),
  sessionIds: new Set(),
  runIds: new Set(),
});

/** Local providers have no external process to reattach. The live runtime supplies this bridge. */
export class HostedProviderRecovery extends Context.Reference<{
  readonly preserve: (
    reattach: boolean,
  ) => Effect.Effect<HostedRecoveryState, Adapter.ProviderAdapterV2Error>;
}>("t3/HostedProviderRecovery", {
  defaultValue: () => ({ preserve: () => Effect.succeed(emptyHostedState()) }),
}) {}

export const layer = Layer.effect(
  HostedProviderRecovery,
  Effect.gen(function* () {
    const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const execution = yield* RunExecutionService.RunExecutionServiceV2;
    const mcpRegistry = yield* McpSessionRegistry.McpSessionRegistry;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    let preserved: HostedRecoveryState = emptyHostedState();
    let restored = false;
    const preserve = (reattach: boolean) =>
      Effect.gen(function* () {
        if (reattach && restored) return preserved;
        const threadIdsToPreserve = new Set<ThreadId>();
        const sessionIds = new Set<ProviderSessionId>();
        const runIds = new Set<RunId>();
        preserved = { threadIds: threadIdsToPreserve, sessionIds, runIds };
        const runtimes: Array<Adapter.ProviderAdapterV2SessionRuntime> = [];
        for (const instanceId of yield* registry.list()) {
          const adapter = yield* registry.get(instanceId);
          if (!adapter.hostedSessions) continue;
          for (const hosted of yield* adapter.hostedSessions) {
            const threadIds = new Set([
              hosted.input.threadId,
              ...hosted.turns.map((turn) => turn.threadId),
            ]);
            for (const threadId of threadIds) threadIdsToPreserve.add(threadId);
            sessionIds.add(hosted.session.id);
            for (const turn of hosted.turns) runIds.add(turn.runId);
            if (!reattach) continue;
            for (const config of hosted.mcpSessions) {
              const credential = yield* mcpRegistry.resolve(
                config.authorizationHeader.replace(/^Bearer\s+/, ""),
              );
              if (
                !credential ||
                credential.environmentId !== config.environmentId ||
                credential.thread.threadId !== config.threadId ||
                credential.thread.providerSessionId !== config.providerSessionId ||
                credential.thread.providerInstanceId !== config.providerInstanceId
              ) {
                return yield* new Adapter.ProviderAdapterProtocolError({
                  driver: adapter.driver,
                  detail:
                    "The hosted Codex MCP credential could not be restored from the persisted registry.",
                });
              }
              yield* mcpSessions.set(config);
            }
            const snapshots = new Map<
              ThreadId,
              Awaited<Effect.Success<ReturnType<typeof projections.getThreadProjection>>>
            >();
            for (const threadId of threadIds)
              snapshots.set(threadId, yield* projections.getThreadProjection(threadId));
            const resumedTurns = hosted.turns
              .filter((turn) =>
                snapshots
                  .get(turn.threadId)
                  ?.runs.some(
                    (run) =>
                      run.id === turn.runId &&
                      run.activeAttemptId === turn.attemptId &&
                      ["starting", "running", "waiting"].includes(run.status),
                  ),
              )
              .map((turn) => ({
                providerThreadId: turn.providerThread.id,
                runOrdinal: turn.runOrdinal,
              }));
            const session = yield* manager.open({
              ...hosted.input,
              resumeFromSession: hosted.session,
              resumedTurns,
            });
            runtimes.push(session);
            for (const threadId of threadIds) {
              if (threadId !== hosted.input.threadId)
                yield* manager.open({
                  ...hosted.input,
                  threadId,
                  resumeFromSession: hosted.session,
                });
            }
            for (const turn of hosted.turns) {
              const projection = yield* projections.getThreadProjection(turn.threadId);
              const run = projection.runs.find(
                (run) => run.id === turn.runId && run.activeAttemptId === turn.attemptId,
              );
              if (!run || !["starting", "running", "waiting", "completed"].includes(run.status))
                continue;
              const attempt = projection.attempts.find((attempt) => attempt.id === turn.attemptId);
              const rootNode = projection.nodes.find((node) => node.id === turn.rootNodeId);
              const checkpointScope = projection.checkpointScopes.find(
                (scope) => scope.id === rootNode?.checkpointScopeId,
              );
              const providerThread = projection.providerThreads.find(
                (thread) => thread.id === turn.providerThread.id,
              );
              const relatedSubagents = projection.subagents.filter(
                (agent) => agent.runId === run.id,
              );
              const relatedProviderThreadIds = relatedSubagents.flatMap((agent) =>
                agent.providerThreadId === null ? [] : [agent.providerThreadId],
              );
              const resumeEvents: Array<Adapter.ProviderAdapterV2Event> = [
                ...projection.turnItems
                  .filter(
                    (item) =>
                      item.runId === run.id &&
                      ["command_execution", "dynamic_tool", "subagent"].includes(item.type) &&
                      isOrchestrationV2WorkActive(item.status),
                  )
                  .map((turnItem) => ({
                    type: "turn_item.updated" as const,
                    driver: adapter.driver,
                    turnItem,
                  })),
                ...relatedSubagents
                  .filter((agent) => isOrchestrationV2WorkActive(agent.status))
                  .map((subagent) => ({
                    type: "subagent.updated" as const,
                    driver: adapter.driver,
                    subagent,
                  })),
                ...projection.nodes
                  .filter(
                    (node) =>
                      node.runId === run.id &&
                      node.kind === "subagent" &&
                      isOrchestrationV2WorkActive(node.status),
                  )
                  .map((node) => ({ type: "node.updated" as const, driver: adapter.driver, node })),
                ...projection.providerTurns
                  .filter(
                    (providerTurn) =>
                      relatedProviderThreadIds.includes(providerTurn.providerThreadId) &&
                      isOrchestrationV2WorkActive(providerTurn.status),
                  )
                  .map((providerTurn) => ({
                    type: "provider_turn.updated" as const,
                    driver: adapter.driver,
                    providerTurn,
                  })),
              ];
              // The latest completed run also owns roster-only work, which may have no
              // turn-item row. Older completed runs need an explicit live background row.
              if (
                run.status === "completed" &&
                resumeEvents.length === 0 &&
                providerThread?.lastRunOrdinal !== run.ordinal
              )
                continue;
              if (!attempt || !rootNode || !checkpointScope || !providerThread) {
                return yield* new Adapter.ProviderAdapterProtocolError({
                  driver: adapter.driver,
                  detail: `Hosted Codex run ${turn.runId} has incomplete persisted recovery state.`,
                });
              }
              yield* execution.startRootRun({
                commandId: CommandId.make(`command:host-recovery:${turn.attemptId}`),
                appThread: projection.thread,
                providerSessionId: session.providerSessionId,
                session,
                run,
                rootNode,
                checkpointScope,
                providerThread,
                attempt,
                attemptId: turn.attemptId,
                providerTurnOrdinal: turn.providerTurnOrdinal,
                message: turn.message,
                modelSelection: turn.modelSelection,
                runtimePolicy: turn.runtimePolicy,
                resumeExistingTurn: true,
                resumeEvents,
                relatedThreadIds: relatedSubagents.flatMap((subagent) =>
                  subagent.childThreadId === null ? [] : [subagent.childThreadId],
                ),
                relatedProviderThreadIds,
                shouldFinalizeRun: () =>
                  projections
                    .getThreadProjection(turn.threadId)
                    .pipe(
                      Effect.map((latest) =>
                        latest.runs.some(
                          (candidate) =>
                            candidate.id === turn.runId &&
                            candidate.activeAttemptId === turn.attemptId &&
                            ["running", "waiting", "starting"].includes(candidate.status),
                        ),
                      ),
                    ),
              });
            }
          }
        }
        // Every run subscriber must exist before the instance-wide replay starts.
        for (const runtime of runtimes)
          if (runtime.externalLifetime) yield* runtime.externalLifetime.replay;
        if (reattach) restored = true;
        return preserved;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new Adapter.ProviderAdapterProtocolError({
              driver: ProviderDriverKind.make("codex"),
              detail: "Could not reattach the external Codex runtime.",
              payload: cause,
            }),
        ),
      );
    return { preserve };
  }),
);
