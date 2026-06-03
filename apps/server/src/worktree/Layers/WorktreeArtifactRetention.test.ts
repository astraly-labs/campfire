// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { WorktreeArtifactRetention } from "../Services/WorktreeArtifactRetention.ts";
import { makeWorktreeArtifactRetentionLive } from "./WorktreeArtifactRetention.ts";

const drainFibers = Effect.forEach(Array.from({ length: 200 }), () => Effect.yieldNow, {
  discard: true,
});

function makeServerConfigStub(worktreesDir: string): ServerConfigShape {
  return {
    stateDir: "",
    dbPath: "",
    keybindingsConfigPath: "",
    settingsPath: "",
    providerStatusCacheDir: "",
    worktreesDir,
    attachmentsDir: "",
    logsDir: "",
    serverLogPath: "",
    serverTracePath: "",
    providerLogsDir: "",
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

interface ProjectLayout {
  readonly project: string;
  readonly worktree: string;
  /** Milliseconds-ago to back-date the worktree directory's mtime. */
  readonly mtimeAgoMs: number;
  /** Artifact directories to create inside the worktree. */
  readonly artifacts: ReadonlyArray<string>;
  /** Non-artifact source files to leave untouched. */
  readonly sources?: ReadonlyArray<string>;
}

function layoutWorktrees(rootDir: string, layouts: ReadonlyArray<ProjectLayout>): void {
  const now = Date.now();
  for (const layout of layouts) {
    const projectDir = path.join(rootDir, layout.project);
    fs.mkdirSync(projectDir, { recursive: true });
    const worktreeDir = path.join(projectDir, layout.worktree);
    fs.mkdirSync(worktreeDir, { recursive: true });
    for (const artifact of layout.artifacts) {
      const dir = path.join(worktreeDir, artifact);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "placeholder.bin"), "x".repeat(64));
    }
    for (const source of layout.sources ?? []) {
      fs.writeFileSync(path.join(worktreeDir, source), "fn main() {}");
    }
    // Back-date the worktree dir mtime so the sweep treats it as idle.
    const target = new Date(now - layout.mtimeAgoMs);
    fs.utimesSync(worktreeDir, target, target);
  }
}

describe("WorktreeArtifactRetention", () => {
  let tempDir: string;
  let runtime: ManagedRuntime.ManagedRuntime<WorktreeArtifactRetention, unknown> | null = null;
  let scope: Scope.Closeable | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-worktree-artifact-retention-"));
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
    const layer = makeWorktreeArtifactRetentionLive({
      retentionMs,
      sweepIntervalMs: 60 * 60 * 1000,
      worktreesDir: tempDir,
    }).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, makeServerConfigStub(tempDir))),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const retention = await runtime.runPromise(Effect.service(WorktreeArtifactRetention));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(retention.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(drainFibers);
  }

  it("removes target/.venv/node_modules from worktrees idle past the retention window", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    layoutWorktrees(tempDir, [
      {
        project: "market-maker-extended",
        worktree: "t3code-old",
        mtimeAgoMs: 10 * dayMs,
        artifacts: ["target", ".venv", "node_modules", ".pytest_cache"],
        sources: ["main.rs"],
      },
    ]);

    await startRetention(7 * dayMs);

    const wtDir = path.join(tempDir, "market-maker-extended", "t3code-old");
    expect(fs.existsSync(path.join(wtDir, "target"))).toBe(false);
    expect(fs.existsSync(path.join(wtDir, ".venv"))).toBe(false);
    expect(fs.existsSync(path.join(wtDir, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(wtDir, ".pytest_cache"))).toBe(false);
    // The source file (and the worktree directory itself) must be preserved.
    expect(fs.existsSync(path.join(wtDir, "main.rs"))).toBe(true);
  });

  it("leaves recent worktrees alone (their artifacts may be in active use)", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    layoutWorktrees(tempDir, [
      {
        project: "alpha-engine",
        worktree: "t3code-recent",
        mtimeAgoMs: 1 * dayMs,
        artifacts: ["target", ".venv"],
      },
    ]);

    await startRetention(7 * dayMs);

    const wtDir = path.join(tempDir, "alpha-engine", "t3code-recent");
    expect(fs.existsSync(path.join(wtDir, "target"))).toBe(true);
    expect(fs.existsSync(path.join(wtDir, ".venv"))).toBe(true);
  });

  it("scans all projects under worktreesDir", async () => {
    const dayMs = 24 * 60 * 60 * 1000;
    layoutWorktrees(tempDir, [
      {
        project: "project-a",
        worktree: "t3code-a1",
        mtimeAgoMs: 10 * dayMs,
        artifacts: ["target"],
      },
      {
        project: "project-b",
        worktree: "t3code-b1",
        mtimeAgoMs: 10 * dayMs,
        artifacts: [".venv"],
      },
      {
        project: "project-c",
        worktree: "t3code-c1-fresh",
        mtimeAgoMs: 1 * dayMs,
        artifacts: ["node_modules"],
      },
    ]);

    await startRetention(7 * dayMs);

    expect(fs.existsSync(path.join(tempDir, "project-a", "t3code-a1", "target"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "project-b", "t3code-b1", ".venv"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "project-c", "t3code-c1-fresh", "node_modules"))).toBe(
      true,
    );
  });

  it("tolerates a missing worktrees directory", async () => {
    const missingDir = path.join(tempDir, "nope");
    const layer = makeWorktreeArtifactRetentionLive({
      retentionMs: 1_000,
      sweepIntervalMs: 60 * 60 * 1000,
      worktreesDir: missingDir,
    }).pipe(
      Layer.provideMerge(Layer.succeed(ServerConfig, makeServerConfigStub(missingDir))),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const retention = await runtime.runPromise(Effect.service(WorktreeArtifactRetention));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(retention.start().pipe(Scope.provide(scope)));
    await Effect.runPromise(drainFibers);
    expect(fs.existsSync(missingDir)).toBe(false);
  });
});
