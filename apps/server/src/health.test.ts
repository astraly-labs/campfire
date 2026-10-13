import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as SqlClient from "effect/sql/SqlClient";
import { livenessRouteLayer, readinessRouteLayer } from "./http.ts";
import { ServerRuntimeStartup, ServerRuntimeStartupError } from "./serverRuntimeStartup.ts";

it("serves liveness and checks startup plus the V2 database before reporting ready", async () => {
  for (const mode of ["ready", "startup-failed", "database-missing"] as const) {
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const initialized = Layer.effectDiscard(
      Effect.gen(function* () {
        if (mode === "database-missing") return;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TABLE orchestration_v2_projection_threads (id TEXT)`;
      }),
    ).pipe(Layer.provideMerge(database));
    const startup = Layer.succeed(ServerRuntimeStartup, {
      awaitCommandReady:
        mode === "startup-failed"
          ? Effect.fail(
              new ServerRuntimeStartupError({ mode: "web", host: null, port: 0, cause: "fixture" }),
            )
          : Effect.void,
      markHttpListening: Effect.void,
      enqueueCommand: (effect) => effect,
    });
    const app = Layer.mergeAll(livenessRouteLayer, readinessRouteLayer).pipe(
      Layer.provideMerge(initialized),
      Layer.provideMerge(startup),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(app, { disableLogger: true });
    try {
      const live = await handler(new Request("http://localhost/healthz"));
      expect(live.status).toBe(200);
      expect(live.headers.get("cache-control")).toBe("no-store");
      const ready = await handler(new Request("http://localhost/readyz"));
      expect(ready.status).toBe(mode === "ready" ? 200 : 503);
      expect(await ready.json()).toEqual({ status: mode === "ready" ? "ready" : "unavailable" });
    } finally {
      await dispose();
    }
  }
});
