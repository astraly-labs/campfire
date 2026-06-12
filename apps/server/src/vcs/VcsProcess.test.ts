import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import { VcsProcessExitError, VcsProcessTimeoutError } from "@t3tools/contracts";
import * as VcsProcess from "./VcsProcess.ts";

const run = (input: VcsProcess.VcsProcessInput) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return yield* process.run(input);
  });

const liveLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));

const provideLive = <A, E, R>(effect: Effect.Effect<A, E, R | VcsProcess.VcsProcess>) =>
  effect.pipe(Effect.provide(liveLayer));

describe("VcsProcess.run", () => {
  it.effect("collects stdout", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.stdout",
        command: "node",
        args: ["-e", "process.stdout.write('hello')"],
        cwd: process.cwd(),
      });

      expect(result.stdout).toBe("hello");
      expect(result.stderr).toBe("");
      expect(result.stdoutTruncated).toBe(false);
      expect(result.stderrTruncated).toBe(false);
    }).pipe(provideLive),
  );

  it.effect("writes stdin before waiting for exit", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.stdin",
        command: "node",
        args: [
          "-e",
          [
            "process.stdin.setEncoding('utf8');",
            "let data='';",
            "process.stdin.on('data', chunk => { data += chunk; });",
            "process.stdin.on('end', () => { process.stdout.write(data); });",
          ].join(""),
        ],
        cwd: process.cwd(),
        stdin: "stdin payload",
      });

      expect(result.stdout).toBe("stdin payload");
    }).pipe(provideLive),
  );

  it.effect("fails with VcsProcessExitError for non-zero exits by default", () =>
    Effect.gen(function* () {
      const error = yield* run({
        operation: "test.exit",
        command: "node",
        args: ["-e", "process.stderr.write('boom'); process.exit(2)"],
        cwd: process.cwd(),
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsProcessExitError);
    }).pipe(provideLive),
  );

  it.effect("returns output when non-zero exits are allowed", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.allowed-exit",
        command: "node",
        args: ["-e", "process.stderr.write('boom'); process.exit(2)"],
        cwd: process.cwd(),
        allowNonZeroExit: true,
      });

      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe("boom");
    }).pipe(provideLive),
  );

  it.effect("truncates output and appends the marker when requested", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.truncate-marker",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        cwd: process.cwd(),
        maxOutputBytes: 128,
        appendTruncationMarker: true,
      });

      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout).toContain("[truncated]");
      expect(result.stderrTruncated).toBe(false);
    }).pipe(provideLive),
  );

  it.effect("truncates without the marker when truncation markers are disabled", () =>
    Effect.gen(function* () {
      const result = yield* run({
        operation: "test.truncate-silent",
        command: "node",
        args: ["-e", "process.stdout.write('x'.repeat(2048))"],
        cwd: process.cwd(),
        maxOutputBytes: 128,
      });

      expect(result.stdoutTruncated).toBe(true);
      expect(result.stdout).not.toContain("[truncated]");
    }).pipe(provideLive),
  );

  it.effect("fails with VcsProcessTimeoutError on timeout", () =>
    Effect.gen(function* () {
      const errorFiber = yield* run({
        operation: "test.timeout",
        command: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
        cwd: process.cwd(),
        timeoutMs: 50,
      }).pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(50));
      const error = yield* Fiber.join(errorFiber);

      expect(error).toBeInstanceOf(VcsProcessTimeoutError);
    }).pipe(provideLive),
  );

  it.effect("fails fast on a cwd that recently timed out, then reprobes after the window", () =>
    Effect.gen(function* () {
      const slowCommand = {
        operation: "test.breaker",
        command: "node",
        args: ["-e", "setTimeout(() => {}, 5000)"],
        cwd: process.cwd(),
        timeoutMs: 50,
      } as const;

      // First call: real timeout trips the breaker for this cwd.
      const tripFiber = yield* run(slowCommand).pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(50));
      expect(yield* Fiber.join(tripFiber)).toBeInstanceOf(VcsProcessTimeoutError);

      // Second call: must fail without any TestClock advance — if the
      // breaker were not tripping, this un-forked run would wait on the
      // (test) clock forever and the test itself would hang. The frozen-
      // filesystem case must not hold a worker for another timeout.
      const fastError = yield* run({ ...slowCommand, operation: "test.breaker-fast" }).pipe(
        Effect.flip,
      );
      expect(fastError).toBeInstanceOf(VcsProcessTimeoutError);

      // After the retry window, one probe is allowed through again — it
      // spawns for real and needs the clock to advance to time out.
      yield* TestClock.adjust(Duration.minutes(6));
      const reprobeFiber = yield* run({ ...slowCommand, operation: "test.breaker-reprobe" }).pipe(
        Effect.flip,
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.millis(50));
      expect(yield* Fiber.join(reprobeFiber)).toBeInstanceOf(VcsProcessTimeoutError);

      // A healthy cwd is unaffected even while another cwd is tripped.
      const healthy = yield* run({
        operation: "test.breaker-healthy",
        command: "node",
        args: ["-e", "process.stdout.write('ok')"],
        cwd: `${process.cwd()}/src`,
      });
      expect(healthy.stdout).toBe("ok");
    }).pipe(provideLive),
  );
});
