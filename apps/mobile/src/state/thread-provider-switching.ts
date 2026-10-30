import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  resolveActiveThreadRun,
  threadSupportsProviderHandoff,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

type ThreadStartMarkers = Pick<
  EnvironmentThreadShell,
  "latestRun" | "latestUserMessageAt" | "runtime"
>;

function threadShellHasStarted(thread: ThreadStartMarkers | null | undefined): boolean {
  return Boolean(
    thread &&
    (thread.latestRun !== null || thread.latestUserMessageAt !== null || thread.runtime !== null),
  );
}

/**
 * Whether this thread's model picker may offer providers other than the one it
 * runs on, matching web's locked-provider rule: a thread that never ran a turn
 * is bound to nothing, and a started thread stays on its provider when its
 * session cannot hand the conversation to another one. It also stays while a
 * turn runs: the server applies a new selection at once, and leaving the
 * instance restarts its session, which stops the turn.
 */
export function threadAllowsProviderSwitch(input: {
  readonly thread: ThreadStartMarkers | null | undefined;
  readonly projection: OrchestrationV2ThreadProjection | null | undefined;
}): boolean {
  return input.projection != null
    ? resolveActiveThreadRun(input.projection) === null &&
        threadSupportsProviderHandoff(input.projection)
    : !threadShellHasStarted(input.thread);
}
