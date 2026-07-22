import type {
  AuthSessionId,
  PresenceEntry,
  PresenceHeartbeatInput,
  PresenceHeartbeatResult,
  PresenceSnapshot,
  PresenceUser,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const DEFAULT_CAPACITY = 64;
const DEFAULT_PRESENCE_TTL_MS = 15_000;
const DEFAULT_TYPING_TTL_MS = 4_000;
const DEFAULT_SWEEP_INTERVAL_MS = 1_000;

interface InternalEntry {
  readonly connectionId: string;
  readonly sessionId: AuthSessionId;
  readonly user: PresenceUser;
  readonly threadId: PresenceHeartbeatInput["threadId"];
  readonly typing: boolean;
  readonly lastSeenAtMs: number;
  readonly typingSeenAtMs: number | null;
}

interface PresenceState {
  readonly revision: number;
  readonly entries: ReadonlyMap<string, InternalEntry>;
}

export interface PresenceOptions {
  readonly capacity?: number;
  readonly presenceTtlMs?: number;
  readonly typingTtlMs?: number;
  readonly sweepIntervalMs?: number;
}

export class Presence extends Context.Service<
  Presence,
  {
    readonly touch: (input: {
      readonly connectionId: string;
      readonly sessionId: AuthSessionId;
      readonly user: PresenceUser;
      readonly focus: PresenceHeartbeatInput;
    }) => Effect.Effect<PresenceHeartbeatResult>;
    readonly drop: (connectionId: string) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<PresenceSnapshot>;
    readonly snapshots: Stream.Stream<PresenceSnapshot>;
  }
>()("t3/presence/Presence") {}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(1, Math.trunc(value));
}

function entriesBySession(entries: ReadonlyMap<string, InternalEntry>): InternalEntry[] {
  const latest = new Map<AuthSessionId, InternalEntry>();
  for (const entry of entries.values()) {
    const previous = latest.get(entry.sessionId);
    if (
      previous === undefined ||
      entry.lastSeenAtMs > previous.lastSeenAtMs ||
      (entry.lastSeenAtMs === previous.lastSeenAtMs &&
        entry.connectionId.localeCompare(previous.connectionId) > 0)
    ) {
      latest.set(entry.sessionId, entry);
    }
  }
  return Array.from(latest.values());
}

function visibleState(entries: ReadonlyMap<string, InternalEntry>): string {
  return JSON.stringify(
    entriesBySession(entries)
      .toSorted((left, right) => left.sessionId.localeCompare(right.sessionId))
      .map((entry) => [
        entry.sessionId,
        entry.user.subject,
        entry.user.displayName,
        entry.user.networkLogin ?? null,
        entry.threadId,
        entry.typing,
      ]),
  );
}

function toSnapshot(state: PresenceState, nowMs: number): PresenceSnapshot {
  const entries: PresenceEntry[] = entriesBySession(state.entries)
    .toSorted(
      (left, right) =>
        left.user.displayName.localeCompare(right.user.displayName) ||
        left.user.subject.localeCompare(right.user.subject) ||
        left.sessionId.localeCompare(right.sessionId),
    )
    .map((entry) => ({
      sessionId: entry.sessionId,
      user: entry.user,
      threadId: entry.threadId,
      typing: entry.typing,
      lastSeenAt: DateTime.formatIso(DateTime.makeUnsafe(entry.lastSeenAtMs)),
    }));
  return {
    revision: state.revision,
    serverTime: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
    entries,
  };
}

export const make = (options?: PresenceOptions) =>
  Effect.gen(function* () {
    const capacity = normalizePositiveInt(options?.capacity, DEFAULT_CAPACITY);
    const presenceTtlMs = normalizePositiveInt(options?.presenceTtlMs, DEFAULT_PRESENCE_TTL_MS);
    const typingTtlMs = normalizePositiveInt(options?.typingTtlMs, DEFAULT_TYPING_TTL_MS);
    const sweepIntervalMs = normalizePositiveInt(
      options?.sweepIntervalMs,
      DEFAULT_SWEEP_INTERVAL_MS,
    );
    const state = yield* Ref.make<PresenceState>({ revision: 0, entries: new Map() });
    const changes = yield* PubSub.sliding<PresenceSnapshot>(1);

    const publish = (next: PresenceState, nowMs: number) =>
      PubSub.publish(changes, toSnapshot(next, nowMs)).pipe(Effect.asVoid);

    const touch: Presence["Service"]["touch"] = (input) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const result = yield* Ref.modify(state, (current) => {
          const nextEntry: InternalEntry = {
            connectionId: input.connectionId,
            sessionId: input.sessionId,
            user: input.user,
            threadId: input.focus.threadId,
            typing: input.focus.typing,
            lastSeenAtMs: nowMs,
            typingSeenAtMs: input.focus.typing ? nowMs : null,
          };
          const nextEntries = new Map(current.entries);
          if (!nextEntries.has(input.connectionId) && nextEntries.size >= capacity) {
            const oldest = Array.from(nextEntries.values()).toSorted(
              (left, right) =>
                left.lastSeenAtMs - right.lastSeenAtMs ||
                left.connectionId.localeCompare(right.connectionId),
            )[0];
            if (oldest !== undefined) nextEntries.delete(oldest.connectionId);
          }
          nextEntries.set(input.connectionId, nextEntry);
          const changed = visibleState(current.entries) !== visibleState(nextEntries);
          const next = changed
            ? { revision: current.revision + 1, entries: nextEntries }
            : { ...current, entries: nextEntries };
          return [{ next, changed }, next] as const;
        });
        if (result.changed) yield* publish(result.next, nowMs);
        return {
          revision: result.next.revision,
          serverTime: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
        };
      });

    const drop: Presence["Service"]["drop"] = (connectionId) =>
      Effect.gen(function* () {
        const nowMs = yield* Clock.currentTimeMillis;
        const result = yield* Ref.modify(state, (current) => {
          if (!current.entries.has(connectionId)) {
            return [{ next: current, changed: false }, current];
          }
          const entries = new Map(current.entries);
          entries.delete(connectionId);
          const changed = visibleState(current.entries) !== visibleState(entries);
          const next = changed
            ? { revision: current.revision + 1, entries }
            : { ...current, entries };
          return [{ next, changed }, next];
        });
        if (result.changed) yield* publish(result.next, nowMs);
      });

    const snapshot = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      return toSnapshot(yield* Ref.get(state), nowMs);
    });

    const sweep = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const result = yield* Ref.modify(state, (current) => {
        let changed = false;
        const entries = new Map<string, InternalEntry>();
        for (const entry of current.entries.values()) {
          if (nowMs - entry.lastSeenAtMs > presenceTtlMs) {
            changed = true;
            continue;
          }
          if (
            entry.typing &&
            (entry.typingSeenAtMs === null || nowMs - entry.typingSeenAtMs > typingTtlMs)
          ) {
            entries.set(entry.connectionId, {
              ...entry,
              typing: false,
              typingSeenAtMs: null,
            });
            changed = true;
          } else {
            entries.set(entry.connectionId, entry);
          }
        }
        if (!changed) return [{ next: current, changed: false }, current];
        const visiblyChanged = visibleState(current.entries) !== visibleState(entries);
        const next = visiblyChanged
          ? { revision: current.revision + 1, entries }
          : { ...current, entries };
        return [{ next, changed: visiblyChanged }, next];
      });
      if (result.changed) yield* publish(result.next, nowMs);
    });

    yield* sweep.pipe(
      Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
      Effect.forkScoped,
    );

    const snapshots = Stream.unwrap(
      PubSub.subscribe(changes).pipe(
        Effect.map((subscription) => {
          const updates = Stream.fromEffect(PubSub.take(subscription)).pipe(
            Stream.repeat(Schedule.forever),
          );
          return Stream.concat(Stream.fromEffect(snapshot), updates);
        }),
      ),
    );

    return Presence.of({ touch, drop, snapshot, snapshots });
  });

export const layer = Layer.effect(Presence, make());

export const layerTest = (options?: PresenceOptions) => Layer.effect(Presence, make(options));

export const limits = {
  capacity: DEFAULT_CAPACITY,
  presenceTtlMs: DEFAULT_PRESENCE_TTL_MS,
  typingTtlMs: DEFAULT_TYPING_TTL_MS,
  sweepIntervalMs: DEFAULT_SWEEP_INTERVAL_MS,
} as const;
