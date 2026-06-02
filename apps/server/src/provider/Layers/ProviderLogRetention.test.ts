// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { ProviderLogRetention } from "../Services/ProviderLogRetention.ts";
import { makeProviderLogRetentionLive } from "./ProviderLogRetention.ts";

const drainFibers = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
  discard: true,
});

function makeServerConfigStub(providerLogsDir: string): ServerConfigShape {
  return {
    stateDir: "",
    dbPath: "",
    keybindingsConfigPath: "",
    settingsPath: "",
    providerStatusCacheDir: "",
    worktreesDir: "",
    attachmentsDir: "",
    logsDir: "",
    serverLogPath: "",
    serverTracePath: "",
    providerLogsDir,
    providerEventLogPath: "",
    terminalLogsDir: "",
    anonymousIdPath: "",
    environmentIdPath: "",
    serverRuntimeStatePath: "",
    secretsDir: "",
    logLevel: "Info",
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 0,
    traceMaxBytes: 0,
    traceMaxFiles: 0,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 0,
    otlpServiceName: "",
    mode: "web",
    port: 0,
    host: undefined,
    cwd: "",
    baseDir: "",
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: false,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 0,
  };
}

describe("ProviderLogRetention", () => {
  let tempDir: string;
  let runtime: ManagedRuntime.ManagedRuntime<ProviderLogRetention, unknown> | null = null;
  let scope: Scope.Closeable | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-log-retention-"));
  });

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function startRetention(retentionMs: number): Promise<void> {
    const layer = makeProviderLogRetentionLive({
      retentionMs,
      // A wide sweep interval: we only need the first run (which fires
      // immediately under Effect.repeat(Schedule.spaced(...))).
      sweepIntervalMs: 60 * 60 * 1000,
      providerLogsDir: tempDir,
    }).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, makeServerConfigStub(tempDir))),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const retention = await runtime.runPromise(Effect.service(ProviderLogRetention));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(retention.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(drainFibers);
  }

  it("deletes files with mtime older than the retention window and keeps fresh files", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const oldPath = path.join(tempDir, "thread-old.log");
    const olderPath = path.join(tempDir, "thread-older.log.3");
    const recentPath = path.join(tempDir, "thread-recent.log");

    fs.writeFileSync(oldPath, "old\n");
    fs.writeFileSync(olderPath, "older\n");
    fs.writeFileSync(recentPath, "recent\n");

    const eightDaysAgo = new Date(now - 8 * dayMs);
    const thirtyDaysAgo = new Date(now - 30 * dayMs);
    const oneHourAgo = new Date(now - 60 * 60 * 1000);

    fs.utimesSync(oldPath, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(olderPath, thirtyDaysAgo, thirtyDaysAgo);
    fs.utimesSync(recentPath, oneHourAgo, oneHourAgo);

    await startRetention(7 * dayMs);

    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(olderPath)).toBe(false);
    expect(fs.existsSync(recentPath)).toBe(true);
  });

  it("tolerates a missing provider logs directory", async () => {
    const missingDir = path.join(tempDir, "does-not-exist");
    const layer = makeProviderLogRetentionLive({
      retentionMs: 1_000,
      sweepIntervalMs: 60 * 60 * 1000,
      providerLogsDir: missingDir,
    }).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, makeServerConfigStub(missingDir))),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const retention = await runtime.runPromise(Effect.service(ProviderLogRetention));
    scope = await Effect.runPromise(Scope.make("sequential"));
    // start() must not throw; an empty/missing dir is the steady state on a
    // brand-new install before any adapter has written a thread log.
    await Effect.runPromise(retention.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(drainFibers);
    expect(fs.existsSync(missingDir)).toBe(false);
  });

  it("does not delete subdirectories — only regular files are eligible", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const subDir = path.join(tempDir, "thread-dir");
    fs.mkdirSync(subDir);
    fs.utimesSync(subDir, new Date(now - 30 * dayMs), new Date(now - 30 * dayMs));

    await startRetention(7 * dayMs);

    expect(fs.existsSync(subDir)).toBe(true);
  });
});
