import {
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2Notification,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  ProviderUsageLimitsUpdate,
  ProviderUserInputAnswers,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as Adapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Schema from "effect/Schema";

export const PROTOCOL_VERSION = 2;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_BUFFER_BYTES = 64 * 1024 * 1024;
export const MAX_COMMAND_RECEIPTS = 10_000;

export const OpenSession = Schema.Struct({
  lifetime: Schema.optionalKey(Schema.Literal("ephemeral")),
  threadId: ThreadId,
  providerSessionId: ProviderSessionId,
  modelSelection: ModelSelection,
  runtimePolicy: Adapter.ProviderAdapterV2RuntimePolicy,
  resumeFromSession: Schema.optionalKey(OrchestrationV2ProviderSession),
  initialNativeThreadId: Schema.optionalKey(Schema.String),
  initialProviderItemIdentityVersion: Schema.optionalKey(Schema.Literal(2)),
});
export const McpSession = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  endpoint: Schema.String,
  authorizationHeader: Schema.String,
  browserToolsAvailable: Schema.Boolean,
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
  agentDeviceEnvironment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export const Configuration = Schema.Struct({
  config: CodexSettings,
  environment: ProviderInstanceEnvironment,
});
export const EffectiveRuntime = Schema.Struct({
  revision: Schema.String,
  config: CodexSettings,
  environment: Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String)),
});
export const EnsureThread = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optionalKey(Schema.String),
  modelSelection: ModelSelection,
  runtimePolicy: Adapter.ProviderAdapterV2RuntimePolicy,
  providerSessionId: Schema.optionalKey(ProviderSessionId),
  existingProviderThread: Schema.optionalKey(OrchestrationV2ProviderThread),
});
export const ResumeThread = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  threadId: Schema.optionalKey(ThreadId),
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimePolicy: Schema.optionalKey(Adapter.ProviderAdapterV2RuntimePolicy),
});
export const Turn = Schema.Struct({
  appThread: OrchestrationV2AppThread,
  threadId: ThreadId,
  runId: RunId,
  runOrdinal: Schema.Number,
  nativeThreadHasTurns: Schema.optionalKey(Schema.Boolean),
  providerTurnOrdinal: Schema.Number,
  restartContinuationOfRunId: Schema.optionalKey(RunId),
  attemptId: RunAttemptId,
  rootNodeId: NodeId,
  providerThread: OrchestrationV2ProviderThread,
  message: Adapter.ProviderAdapterV2TurnMessage,
  modelSelection: ModelSelection,
  runtimePolicy: Adapter.ProviderAdapterV2RuntimePolicy,
  appContext: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, text: Schema.String })),
  ),
});
export const Steer = Schema.Struct({
  threadId: ThreadId,
  runId: RunId,
  providerThread: OrchestrationV2ProviderThread,
  providerTurnId: ProviderTurnId,
  message: Adapter.ProviderAdapterV2TurnMessage,
});
export const Interrupt = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  providerTurnId: ProviderTurnId,
  requestRuntimeRestart: Schema.optionalKey(Schema.Boolean),
});
export const Respond = Schema.Struct({
  requestId: RuntimeRequestId,
  decision: Schema.optionalKey(ProviderApprovalDecision),
  answers: Schema.optionalKey(ProviderUserInputAnswers),
  response: Schema.optionalKey(Schema.Unknown),
});
export const Thread = Schema.Struct({ providerThread: OrchestrationV2ProviderThread });
export const ThreadSnapshot = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  providerTurns: Schema.Array(OrchestrationV2ProviderTurn),
  messages: Schema.Array(OrchestrationV2ConversationMessage),
  runtimeRequests: Schema.Array(OrchestrationV2RuntimeRequest),
  providerPayload: Schema.optionalKey(Schema.Unknown),
});
export const Rollback = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  target: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("thread_start"),
      checkpointId: CheckpointId,
      appRunOrdinal: Schema.Literal(0),
    }),
    Schema.Struct({
      type: Schema.Literal("provider_turn"),
      checkpointId: CheckpointId,
      appRunOrdinal: Schema.Number,
      providerTurn: OrchestrationV2ProviderTurn,
    }),
  ]),
  providerThreadTurns: Schema.Array(OrchestrationV2ProviderTurn),
});
export const Fork = Schema.Struct({
  sourceProviderThread: OrchestrationV2ProviderThread,
  sourceProviderTurns: Schema.optionalKey(Schema.Array(OrchestrationV2ProviderTurn)),
  providerTurnId: Schema.optionalKey(ProviderTurnId),
  targetThreadId: ThreadId,
  ownerNodeId: Schema.optionalKey(NodeId),
  modelSelection: Schema.optionalKey(ModelSelection),
  runtimePolicy: Schema.optionalKey(Adapter.ProviderAdapterV2RuntimePolicy),
});
export const InjectHistory = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  messages: Schema.Array(OrchestrationV2HistoricalMessage),
  context: Schema.String,
});
export const Feedback = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  reason: Schema.optionalKey(Schema.String),
});
export const StopTask = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  taskId: Schema.String,
});
export const StopSubagent = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  nativeTaskId: Schema.String,
  requestedAt: Schema.optionalKey(Schema.DateTimeUtc),
});
export const SubagentOutcome = Schema.Union([
  Schema.Void,
  Schema.Struct({
    status: Schema.Literals(["completed", "failed", "cancelled"]),
    completedAt: Schema.DateTimeUtc,
    result: Schema.NullOr(Schema.String),
  }),
]);
export const McpToolsInput = Schema.Struct({
  providerThread: OrchestrationV2ProviderThread,
  server: Schema.String,
});
export const McpCallInput = Schema.Struct({
  ...McpToolsInput.fields,
  tool: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Unknown),
});
export const McpResourceInput = Schema.Struct({ ...McpToolsInput.fields, uri: Schema.String });
export const McpTools = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    _meta: Schema.optionalKey(Schema.Unknown),
    annotations: Schema.optionalKey(Schema.Unknown),
  }),
);
export const McpResult = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  structuredContent: Schema.optionalKey(Schema.Unknown),
  isError: Schema.optionalKey(Schema.Boolean),
  _meta: Schema.optionalKey(Schema.Unknown),
});
export const McpResource = Schema.Struct({ contents: Schema.Array(Schema.Unknown) });
export const UsageLimits = Schema.Struct({
  ...ProviderUsageLimitsUpdate.fields,
  checkedAt: Schema.String,
});
export const Continuation = Schema.Struct({
  threadId: ThreadId,
  providerThreadId: OrchestrationV2ProviderThread.fields.id,
  driver: ProviderDriverKind,
  detail: Schema.NullOr(Schema.String),
  notification: Schema.optionalKey(OrchestrationV2Notification),
  delivery: Schema.optionalKey(Schema.Literals(["adapter_buffered", "message_text"])),
  messageId: Schema.optionalKey(MessageId),
});
export const SessionDescription = Schema.Struct({
  input: OpenSession,
  session: OrchestrationV2ProviderSession,
  mcpSessions: Schema.Array(McpSession),
  turns: Schema.Array(Turn),
  methods: Schema.Array(Schema.String),
});
export const Sessions = Schema.Array(SessionDescription);
export const Capabilities = OrchestrationV2ProviderCapabilities;
export const ProviderThread = OrchestrationV2ProviderThread;

export const Operation = Schema.Literals([
  "configure",
  "capabilities",
  "listSessions",
  "openSession",
  "closeSession",
  "ensureThread",
  "resumeThread",
  "startTurn",
  "compactThread",
  "steerTurn",
  "interruptTurn",
  "respondToRuntimeRequest",
  "readThreadSnapshot",
  "rollbackThread",
  "forkThread",
  "injectHistory",
  "unloadThread",
  "stopTask",
  "stopSubagent",
  "uploadFeedback",
  "hasPendingBackgroundWork",
  "hasPendingBackgroundWorkForThread",
  "mcp.listTools",
  "mcp.callTool",
  "mcp.readResource",
]);
export type Operation = typeof Operation.Type;
export const ClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("subscribe"),
    protocolVersion: Schema.Literal(PROTOCOL_VERSION),
    instanceId: ProviderInstanceId,
    after: Schema.Number,
    previousLease: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("replay"), lease: Schema.Number }),
  Schema.Struct({ type: Schema.Literal("ack"), lease: Schema.Number, sequence: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("command"),
    lease: Schema.Number,
    commandId: Schema.String,
    requestId: Schema.String,
    operation: Operation,
    sessionId: Schema.optionalKey(ProviderSessionId),
    payload: Schema.Unknown,
    mcpSessions: Schema.optionalKey(Schema.Array(McpSession)),
    effectiveRuntime: Schema.optionalKey(EffectiveRuntime),
  }),
]);
export type ClientMessage = typeof ClientMessage.Type;
export const ServerMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("subscribed"),
    protocolVersion: Schema.Literal(PROTOCOL_VERSION),
    lease: Schema.Number,
    committed: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("response"),
    requestId: Schema.String,
    result: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    requestId: Schema.String,
    error: Adapter.ProviderAdapterV2Error,
  }),
  Schema.Struct({ type: Schema.Literal("fatal"), detail: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("event"),
    lease: Schema.Number,
    sequence: Schema.Number,
    sessionId: ProviderSessionId,
    event: Adapter.ProviderAdapterV2Event,
  }),
  Schema.Struct({
    type: Schema.Literal("usage"),
    lease: Schema.Number,
    sequence: Schema.Number,
    update: UsageLimits,
  }),
  Schema.Struct({
    type: Schema.Literal("continuation"),
    lease: Schema.Number,
    sequence: Schema.Number,
    request: Continuation,
  }),
]);
export type ServerMessage = typeof ServerMessage.Type;

export function encode<A, I>(schema: Schema.Codec<A, I>, value: A): unknown {
  return Schema.encodeSync(Schema.toCodecJson(schema))(value);
}
export function decode<A, I>(schema: Schema.Codec<A, I>, value: unknown): A {
  return Schema.decodeUnknownSync(Schema.toCodecJson(schema))(value);
}
export const encodeClient = (value: ClientMessage) =>
  JSON.stringify(encode(ClientMessage, value)) + "\n";
export const encodeServer = (value: ServerMessage) =>
  JSON.stringify(encode(ServerMessage, value)) + "\n";
