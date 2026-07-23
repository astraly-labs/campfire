import {
  ApprovalRequestId,
  CodexSettings,
  EnvironmentId,
  ProviderApprovalDecision,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const CODEX_PROVIDER_HOST_PROTOCOL_VERSION = 1;

export const ProviderHostOperation = Schema.Literals([
  "configure",
  "startSession",
  "sendTurn",
  "interruptTurn",
  "respondToRequest",
  "respondToUserInput",
  "stopSession",
  "listSessions",
  "hasSession",
  "readThread",
  "rollbackThread",
  "stopAll",
]);
export type ProviderHostOperation = typeof ProviderHostOperation.Type;

export const ProviderHostConfigurePayload = Schema.Struct({
  config: CodexSettings,
  environment: ProviderInstanceEnvironment,
});
export type ProviderHostConfigurePayload = typeof ProviderHostConfigurePayload.Type;

export const ProviderHostMcpSession = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  providerSessionId: Schema.String,
  providerInstanceId: ProviderInstanceId,
  endpoint: Schema.String,
  authorizationHeader: Schema.String,
});
export type ProviderHostMcpSession = typeof ProviderHostMcpSession.Type;

export const ProviderHostStartSessionPayload = Schema.Struct({
  input: ProviderSessionStartInput,
  mcpSession: Schema.optional(ProviderHostMcpSession),
});

export const ProviderHostInterruptTurnPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});

export const ProviderHostRespondToRequestPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});

export const ProviderHostRespondToUserInputPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});

export const ProviderHostThreadPayload = Schema.Struct({ threadId: ThreadId });
export const ProviderHostRollbackThreadPayload = Schema.Struct({
  threadId: ThreadId,
  numTurns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

const ProtocolVersion = Schema.Literal(CODEX_PROVIDER_HOST_PROTOCOL_VERSION);

export const ProviderHostClientMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("subscribe"),
    protocolVersion: ProtocolVersion,
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    type: Schema.Literal("command"),
    protocolVersion: ProtocolVersion,
    instanceId: ProviderInstanceId,
    lease: Schema.Int,
    requestId: Schema.String,
    commandId: Schema.String,
    operation: ProviderHostOperation,
    payload: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("ack"),
    protocolVersion: ProtocolVersion,
    instanceId: ProviderInstanceId,
    lease: Schema.Int,
    sequence: Schema.Int,
  }),
]);
export type ProviderHostClientMessage = typeof ProviderHostClientMessage.Type;

export const ProviderHostServerMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("subscribed"),
    protocolVersion: ProtocolVersion,
    instanceId: ProviderInstanceId,
    lease: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("response"),
    protocolVersion: ProtocolVersion,
    requestId: Schema.String,
    ok: Schema.Literal(true),
    result: Schema.Unknown,
  }),
  Schema.Struct({
    type: Schema.Literal("response"),
    protocolVersion: ProtocolVersion,
    requestId: Schema.String,
    ok: Schema.Literal(false),
    error: Schema.Struct({
      tag: Schema.String,
      message: Schema.String,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("event"),
    protocolVersion: ProtocolVersion,
    instanceId: ProviderInstanceId,
    lease: Schema.Int,
    sequence: Schema.Int,
    event: ProviderRuntimeEvent,
  }),
]);
export type ProviderHostServerMessage = typeof ProviderHostServerMessage.Type;

export const decodeProviderHostClientMessage = Schema.decodeUnknownSync(ProviderHostClientMessage);
export const decodeProviderHostServerMessage = Schema.decodeUnknownSync(ProviderHostServerMessage);
export const decodeConfigurePayload = Schema.decodeUnknownSync(ProviderHostConfigurePayload);
export const decodeStartSessionPayload = Schema.decodeUnknownSync(ProviderHostStartSessionPayload);
export const decodeSendTurnPayload = Schema.decodeUnknownSync(ProviderSendTurnInput);
export const decodeInterruptTurnPayload = Schema.decodeUnknownSync(
  ProviderHostInterruptTurnPayload,
);
export const decodeRespondToRequestPayload = Schema.decodeUnknownSync(
  ProviderHostRespondToRequestPayload,
);
export const decodeRespondToUserInputPayload = Schema.decodeUnknownSync(
  ProviderHostRespondToUserInputPayload,
);
export const decodeThreadPayload = Schema.decodeUnknownSync(ProviderHostThreadPayload);
export const decodeRollbackThreadPayload = Schema.decodeUnknownSync(
  ProviderHostRollbackThreadPayload,
);
