import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  resolveActiveThreadRun,
  threadSupportsProviderHandoff,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";

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
 * A running turn also keeps its provider: the server applies a new selection at once, and
 * leaving the instance restarts its session, which stops the turn.
 */
export function threadAllowsProviderSwitch(input: {
  readonly thread: ThreadStartMarkers | null | undefined;
  readonly projection: ThreadStructure | null | undefined;
}): boolean {
  return input.projection != null
    ? resolveActiveThreadRun(input.projection) === null &&
        threadSupportsProviderHandoff(input.projection)
    : !threadShellHasStarted(input.thread);
}
