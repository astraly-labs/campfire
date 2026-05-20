// Hand-wired schemas + helpers for Codex's thread/goal/{set,get,clear} RPC.
// The Codex repo (openai/codex) does not publish TypeScript bindings for the
// goal request params/responses — only the two notifications. The request
// shapes here come from codex-rs/app-server-protocol/src/protocol/v2/thread.rs.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ServerNotification__ThreadGoal as GeneratedThreadGoal,
  ServerNotification__ThreadGoalStatus as GeneratedThreadGoalStatus,
} from "./_generated/schema.gen.ts";
import { CodexAppServerClient, type CodexAppServerClientShape } from "./client.ts";
import * as CodexError from "./errors.ts";

export const THREAD_GOAL_SET_METHOD = "thread/goal/set" as const;
export const THREAD_GOAL_GET_METHOD = "thread/goal/get" as const;
export const THREAD_GOAL_CLEAR_METHOD = "thread/goal/clear" as const;

export const ThreadGoalStatus = GeneratedThreadGoalStatus;
export type ThreadGoalStatus = typeof GeneratedThreadGoalStatus.Type;

export const ThreadGoal = GeneratedThreadGoal;
export type ThreadGoal = typeof GeneratedThreadGoal.Type;

const Int64 = Schema.Number.annotate({ format: "int64" }).check(Schema.isInt());

// status: client-settable subset is narrower than the read-only ThreadGoalStatus
// but happens to match exactly what we already have generated, so we reuse it.
export const ThreadGoalSetParams = Schema.Struct({
  threadId: Schema.String,
  objective: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(ThreadGoalStatus)),
  // Upstream Rust uses Option<Option<i64>> (double option) so callers can
  // distinguish "leave unchanged" from "explicitly clear". We don't need
  // tokenBudget control from the UI yet — keep the wire shape compatible
  // by treating absent as "leave unchanged" and null as "clear".
  tokenBudget: Schema.optional(Schema.NullOr(Int64)),
});
export type ThreadGoalSetParams = typeof ThreadGoalSetParams.Type;

export const ThreadGoalSetResponse = Schema.Struct({ goal: ThreadGoal });
export type ThreadGoalSetResponse = typeof ThreadGoalSetResponse.Type;

export const ThreadGoalGetParams = Schema.Struct({ threadId: Schema.String });
export type ThreadGoalGetParams = typeof ThreadGoalGetParams.Type;

export const ThreadGoalGetResponse = Schema.Struct({
  goal: Schema.NullOr(ThreadGoal),
});
export type ThreadGoalGetResponse = typeof ThreadGoalGetResponse.Type;

export const ThreadGoalClearParams = Schema.Struct({ threadId: Schema.String });
export type ThreadGoalClearParams = typeof ThreadGoalClearParams.Type;

export const ThreadGoalClearResponse = Schema.Struct({ cleared: Schema.Boolean });
export type ThreadGoalClearResponse = typeof ThreadGoalClearResponse.Type;

const encodeSet = Schema.encodeEffect(ThreadGoalSetParams);
const decodeSet = Schema.decodeUnknownEffect(ThreadGoalSetResponse);
const encodeGet = Schema.encodeEffect(ThreadGoalGetParams);
const decodeGet = Schema.decodeUnknownEffect(ThreadGoalGetResponse);
const encodeClear = Schema.encodeEffect(ThreadGoalClearParams);
const decodeClear = Schema.decodeUnknownEffect(ThreadGoalClearResponse);

const wrapDecodeError = (method: string) => (error: { issue: unknown }) =>
  CodexError.CodexAppServerRequestError.invalidParams(
    `Invalid response for ${method}`,
    { issue: error.issue },
  );

const wrapEncodeError = (method: string) => (error: { issue: unknown }) =>
  CodexError.CodexAppServerRequestError.invalidParams(
    `Invalid params for ${method}`,
    { issue: error.issue },
  );

const requestRaw = (
  client: CodexAppServerClientShape,
  method: string,
  encoded: unknown,
) => client.raw.request(method, encoded);

export const setThreadGoal = (
  client: CodexAppServerClientShape,
  params: ThreadGoalSetParams,
): Effect.Effect<ThreadGoalSetResponse, CodexError.CodexAppServerError> =>
  encodeSet(params).pipe(
    Effect.mapError(wrapEncodeError(THREAD_GOAL_SET_METHOD)),
    Effect.flatMap((encoded) => requestRaw(client, THREAD_GOAL_SET_METHOD, encoded)),
    Effect.flatMap((raw) =>
      decodeSet(raw).pipe(Effect.mapError(wrapDecodeError(THREAD_GOAL_SET_METHOD))),
    ),
  );

export const getThreadGoal = (
  client: CodexAppServerClientShape,
  params: ThreadGoalGetParams,
): Effect.Effect<ThreadGoalGetResponse, CodexError.CodexAppServerError> =>
  encodeGet(params).pipe(
    Effect.mapError(wrapEncodeError(THREAD_GOAL_GET_METHOD)),
    Effect.flatMap((encoded) => requestRaw(client, THREAD_GOAL_GET_METHOD, encoded)),
    Effect.flatMap((raw) =>
      decodeGet(raw).pipe(Effect.mapError(wrapDecodeError(THREAD_GOAL_GET_METHOD))),
    ),
  );

export const clearThreadGoal = (
  client: CodexAppServerClientShape,
  params: ThreadGoalClearParams,
): Effect.Effect<ThreadGoalClearResponse, CodexError.CodexAppServerError> =>
  encodeClear(params).pipe(
    Effect.mapError(wrapEncodeError(THREAD_GOAL_CLEAR_METHOD)),
    Effect.flatMap((encoded) => requestRaw(client, THREAD_GOAL_CLEAR_METHOD, encoded)),
    Effect.flatMap((raw) =>
      decodeClear(raw).pipe(Effect.mapError(wrapDecodeError(THREAD_GOAL_CLEAR_METHOD))),
    ),
  );

// Re-exported for callers that prefer to access via the Effect service.
export { CodexAppServerClient };
