import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusResult,
  type VcsStatusStreamEvent,
  type LocalApi,
  IDENTITY_WS_METHODS,
  INBOX_WS_METHODS,
  ORCHESTRATION_WS_METHODS,
  PRESENCE_WS_METHODS,
  type ServerSettingsPatch,
  SIDETHREAD_WS_METHODS,
  USERS_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { type WsRpcProtocolClient } from "./protocol";
import { resetWsReconnectBackoff } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

interface StreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
  /**
   * Invoked once when the subscription terminates with a non-transport
   * (domain / RPC-level) error. Useful for detecting cases like "thread
   * not found" without polling, since the underlying stream never emits
   * a snapshot in that case.
   */
  readonly onError?: (error: unknown) => void;
}

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void, options?: StreamSubscriptionOptions) => () => void
    : never;

type RpcInputStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (
        input: RpcInput<TTag>,
        listener: (event: TEvent) => void,
        options?: StreamSubscriptionOptions,
      ) => () => void
    : never;

interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly isHeartbeatFresh: () => boolean;
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
  };
  readonly projects: {
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
  };
  readonly filesystem: {
    readonly browse: RpcUnaryMethod<typeof WS_METHODS.filesystemBrowse>;
  };
  readonly sourceControl: {
    readonly lookupRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlLookupRepository>;
    readonly cloneRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlCloneRepository>;
    readonly publishRepository: RpcUnaryMethod<typeof WS_METHODS.sourceControlPublishRepository>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<LocalApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<LocalApi["shell"]["openInEditor"]>[1];
    }) => ReturnType<LocalApi["shell"]["openInEditor"]>;
  };
  readonly vcs: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.vcsPull>;
    readonly refreshStatus: RpcUnaryMethod<typeof WS_METHODS.vcsRefreshStatus>;
    readonly onStatus: (
      input: RpcInput<typeof WS_METHODS.subscribeVcsStatus>,
      listener: (status: VcsStatusResult) => void,
      options?: StreamSubscriptionOptions,
    ) => () => void;
    readonly listRefs: RpcUnaryMethod<typeof WS_METHODS.vcsListRefs>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.vcsCreateWorktree>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.vcsRemoveWorktree>;
    readonly createRef: RpcUnaryMethod<typeof WS_METHODS.vcsCreateRef>;
    readonly switchRef: RpcUnaryMethod<typeof WS_METHODS.vcsSwitchRef>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.vcsInit>;
  };
  /**
   * Git-specific workflows. Local repository mechanics live under `vcs`.
   */
  readonly git: {
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
    readonly listOpenPullRequests: RpcUnaryMethod<typeof WS_METHODS.gitListOpenPullRequests>;
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    /**
     * Refresh provider snapshots. Pass `{ instanceId }` to refresh a single
     * configured instance; pass no argument (or `{}`) to refresh all.
     */
    readonly refreshProviders: (
      input?: RpcInput<typeof WS_METHODS.serverRefreshProviders>,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverRefreshProviders>>;
    readonly updateProvider: RpcUnaryMethod<typeof WS_METHODS.serverUpdateProvider>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly removeKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverRemoveKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly discoverSourceControl: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverDiscoverSourceControl
    >;
    readonly getTraceDiagnostics: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetTraceDiagnostics>;
    readonly getProcessDiagnostics: RpcUnaryNoArgMethod<
      typeof WS_METHODS.serverGetProcessDiagnostics
    >;
    readonly getProcessResourceHistory: RpcUnaryMethod<
      typeof WS_METHODS.serverGetProcessResourceHistory
    >;
    readonly getHostHealth: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetHostHealth>;
    readonly signalProcess: RpcUnaryMethod<typeof WS_METHODS.serverSignalProcess>;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
    readonly subscribeAuthAccess: RpcStreamMethod<typeof WS_METHODS.subscribeAuthAccess>;
  };
  readonly orchestration: {
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly getArchivedShellSnapshot: RpcUnaryNoArgMethod<
      typeof ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot
    >;
    readonly subscribeShell: RpcStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeShell>;
    readonly subscribeThread: RpcInputStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeThread>;
    readonly generateThreadHandoff: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.generateThreadHandoff
    >;
    readonly generateConversationSummary: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.generateConversationSummary
    >;
    readonly codexCompactThread: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.codexCompactThread>;
    readonly codexStartReview: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.codexStartReview>;
    readonly codexSetThreadGoal: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.codexSetThreadGoal>;
    readonly codexClearThreadGoal: RpcUnaryMethod<
      typeof ORCHESTRATION_WS_METHODS.codexClearThreadGoal
    >;
  };
  readonly sideThread: {
    readonly dispatchCommand: RpcUnaryMethod<typeof SIDETHREAD_WS_METHODS.dispatchCommand>;
    readonly subscribe: RpcInputStreamMethod<typeof SIDETHREAD_WS_METHODS.subscribeSideThread>;
  };
  readonly identity: {
    readonly getCurrentUser: RpcUnaryNoArgMethod<typeof IDENTITY_WS_METHODS.getCurrentUser>;
    readonly setDisplayName: RpcUnaryMethod<typeof IDENTITY_WS_METHODS.setDisplayName>;
    readonly clearDisplayName: RpcUnaryNoArgMethod<typeof IDENTITY_WS_METHODS.clearDisplayName>;
  };
  readonly inbox: {
    readonly list: RpcUnaryNoArgMethod<typeof INBOX_WS_METHODS.list>;
    readonly subscribe: RpcStreamMethod<typeof INBOX_WS_METHODS.subscribe>;
  };
  readonly users: {
    readonly directory: RpcUnaryNoArgMethod<typeof USERS_WS_METHODS.directory>;
  };
  readonly presence: {
    readonly heartbeat: RpcUnaryMethod<typeof PRESENCE_WS_METHODS.heartbeat>;
    readonly subscribe: RpcStreamMethod<typeof PRESENCE_WS_METHODS.subscribe>;
  };
}

export interface CreateWsRpcClientOptions {
  /**
   * Optional factory for a dedicated transport for the terminal namespace.
   * The terminal is the latency-sensitive interactive channel: on a single
   * shared socket, a multi-megabyte thread snapshot or diff response blocks
   * keystroke echo behind it (WebSocket messages cannot interleave). Riding
   * terminal I/O on its own TCP connection makes it immune to that
   * head-of-line blocking.
   *
   * A factory rather than an instance on purpose: a `WsTransport` starts
   * dialing as soon as it is constructed, and most clients never open a
   * terminal — the second socket is only worth paying for on first terminal
   * use. When omitted, the terminal shares the primary transport.
   */
  readonly createTerminalTransport?: () => WsTransport;
}

export function createWsRpcClient(
  transport: WsTransport,
  clientOptions?: CreateWsRpcClientOptions,
): WsRpcClient {
  let lazyTerminalTransport: WsTransport | null = null;
  const terminalTransport = () => {
    const factory = clientOptions?.createTerminalTransport;
    if (!factory) {
      return transport;
    }
    if (!lazyTerminalTransport) {
      lazyTerminalTransport = factory();
    }
    return lazyTerminalTransport;
  };
  return {
    dispose: async () => {
      await Promise.all([
        transport.dispose(),
        lazyTerminalTransport ? lazyTerminalTransport.dispose() : Promise.resolve(),
      ]);
    },
    reconnect: async () => {
      resetWsReconnectBackoff();
      await Promise.all([
        transport.reconnect(),
        lazyTerminalTransport ? lazyTerminalTransport.reconnect() : Promise.resolve(),
      ]);
    },
    isHeartbeatFresh: () => transport.isHeartbeatFresh(),
    terminal: {
      open: (input) =>
        terminalTransport().request((client) => client[WS_METHODS.terminalOpen](input)),
      // Keystrokes and resizes are non-idempotent and only meaningful in the
      // moment: replaying a 30 s old burst of input into a shell after a
      // reconnect would be worse than dropping it, so these stay on the
      // brief blind-retry path instead of waiting for reconnection.
      write: (input) =>
        terminalTransport().request((client) => client[WS_METHODS.terminalWrite](input), {
          retry: "brief",
        }),
      resize: (input) =>
        terminalTransport().request((client) => client[WS_METHODS.terminalResize](input), {
          retry: "brief",
        }),
      clear: (input) =>
        terminalTransport().request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) =>
        terminalTransport().request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) =>
        terminalTransport().request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener, options) =>
        terminalTransport().subscribe(
          (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
          listener,
          {
            ...options,
            tag: WS_METHODS.subscribeTerminalEvents,
          },
        ),
    },
    projects: {
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
    },
    filesystem: {
      browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
    },
    sourceControl: {
      lookupRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlLookupRepository](input)),
      cloneRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlCloneRepository](input)),
      publishRepository: (input) =>
        transport.request((client) => client[WS_METHODS.sourceControlPublishRepository](input)),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
    },
    vcs: {
      pull: (input) => transport.request((client) => client[WS_METHODS.vcsPull](input)),
      refreshStatus: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRefreshStatus](input)),
      onStatus: (input, listener, options) => {
        let current: VcsStatusResult | null = null;
        return transport.subscribe(
          (client) => client[WS_METHODS.subscribeVcsStatus](input),
          (event: VcsStatusStreamEvent) => {
            current = applyGitStatusStreamEvent(current, event);
            listener(current);
          },
          { ...options, tag: WS_METHODS.subscribeVcsStatus },
        );
      },
      listRefs: (input) => transport.request((client) => client[WS_METHODS.vcsListRefs](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.vcsCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.vcsRemoveWorktree](input)),
      createRef: (input) => transport.request((client) => client[WS_METHODS.vcsCreateRef](input)),
      switchRef: (input) => transport.request((client) => client[WS_METHODS.vcsSwitchRef](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.vcsInit](input)),
    },
    git: {
      runStackedAction: async (input, options) => {
        let result: GitRunStackedActionResult | null = null;

        await transport.requestStream(
          (client) => client[WS_METHODS.gitRunStackedAction](input),
          (event) => {
            options?.onProgress?.(event);
            if (event.kind === "action_finished") {
              result = event.result;
            }
          },
        );

        if (result) {
          return result;
        }

        throw new Error("Git action stream completed without a final result.");
      },
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
      listOpenPullRequests: (input) =>
        transport.request((client) => client[WS_METHODS.gitListOpenPullRequests](input)),
    },
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: (input) =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders](input ?? {})),
      updateProvider: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpdateProvider](input)),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      removeKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverRemoveKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      discoverSourceControl: () =>
        transport.request((client) => client[WS_METHODS.serverDiscoverSourceControl]({})),
      getTraceDiagnostics: () =>
        transport.request((client) =>
          client[WS_METHODS.serverGetTraceDiagnostics]({}).pipe(Effect.withTracerEnabled(false)),
        ),
      getProcessDiagnostics: () =>
        transport.request((client) =>
          client[WS_METHODS.serverGetProcessDiagnostics]({}).pipe(Effect.withTracerEnabled(false)),
        ),
      getProcessResourceHistory: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverGetProcessResourceHistory](input).pipe(
            Effect.withTracerEnabled(false),
          ),
        ),
      getHostHealth: () =>
        transport.request((client) =>
          client[WS_METHODS.serverGetHostHealth]({}).pipe(Effect.withTracerEnabled(false)),
        ),
      signalProcess: (input) =>
        transport.request((client) =>
          client[WS_METHODS.serverSignalProcess](input).pipe(Effect.withTracerEnabled(false)),
        ),
      subscribeConfig: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerConfig]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeServerConfig,
        }),
      subscribeLifecycle: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeServerLifecycle]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeServerLifecycle,
        }),
      subscribeAuthAccess: (listener, options) =>
        transport.subscribe((client) => client[WS_METHODS.subscribeAuthAccess]({}), listener, {
          ...options,
          tag: WS_METHODS.subscribeAuthAccess,
        }),
    },
    orchestration: {
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      getArchivedShellSnapshot: () =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]({}),
        ),
      subscribeShell: (listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
          listener,
          { ...options, tag: ORCHESTRATION_WS_METHODS.subscribeShell },
        ),
      subscribeThread: (input, listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeThread](input),
          listener,
          { ...options, tag: ORCHESTRATION_WS_METHODS.subscribeThread },
        ),
      generateThreadHandoff: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.generateThreadHandoff](input),
        ),
      generateConversationSummary: (input) =>
        transport.request((client) =>
          client[ORCHESTRATION_WS_METHODS.generateConversationSummary](input),
        ),
      codexCompactThread: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.codexCompactThread](input)),
      codexStartReview: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.codexStartReview](input)),
      codexSetThreadGoal: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.codexSetThreadGoal](input)),
      codexClearThreadGoal: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.codexClearThreadGoal](input)),
    },
    sideThread: {
      dispatchCommand: (input) =>
        transport.request((client) => client[SIDETHREAD_WS_METHODS.dispatchCommand](input)),
      subscribe: (input, listener, options) =>
        transport.subscribe(
          (client) => client[SIDETHREAD_WS_METHODS.subscribeSideThread](input),
          listener,
          { ...options, tag: SIDETHREAD_WS_METHODS.subscribeSideThread },
        ),
    },
    identity: {
      getCurrentUser: () =>
        transport.request((client) => client[IDENTITY_WS_METHODS.getCurrentUser]({})),
      setDisplayName: (input) =>
        transport.request((client) => client[IDENTITY_WS_METHODS.setDisplayName](input)),
      clearDisplayName: () =>
        transport.request((client) => client[IDENTITY_WS_METHODS.clearDisplayName]({})),
    },
    inbox: {
      list: () => transport.request((client) => client[INBOX_WS_METHODS.list]({})),
      subscribe: (listener, options) =>
        transport.subscribe((client) => client[INBOX_WS_METHODS.subscribe]({}), listener, {
          ...options,
          tag: INBOX_WS_METHODS.subscribe,
        }),
    },
    users: {
      directory: () => transport.request((client) => client[USERS_WS_METHODS.directory]({})),
    },
    presence: {
      // Heartbeats are re-issued every few seconds by the presence loop, so
      // queueing them while the link is down would only replay a stale burst
      // at reconnect. Single attempt; the next tick is the retry.
      heartbeat: (input) =>
        transport.request((client) => client[PRESENCE_WS_METHODS.heartbeat](input), {
          retry: "none",
        }),
      subscribe: (listener, options) =>
        transport.subscribe((client) => client[PRESENCE_WS_METHODS.subscribe]({}), listener, {
          ...options,
          tag: PRESENCE_WS_METHODS.subscribe,
        }),
    },
  };
}
