import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import {
  DATABASE_MIGRATION_PROGRESS_MESSAGE,
  DATABASE_MIGRATIONS_FINISHED_MESSAGE,
  DATABASE_MIGRATIONS_STARTED_MESSAGE,
} from "@t3tools/shared/databaseMigrationLog";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0053 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Migration0055 from "./Migrations/055_OrchestrationV2.ts";
import Migration0056 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Migration0057 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0058 from "./Migrations/058_WebhookRelayDeliveries.ts";
import Migration0059 from "./Migrations/059_McpAppModelContext.ts";
import Migration0060 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
import Migration0061 from "./Migrations/061_PullRequestReviewGuides.ts";
import Campfire0068 from "./Migrations/068_CampfireV2Collaboration.ts";
import Campfire0069 from "./Migrations/069_AuthSessionEmail.ts";
import Campfire0070 from "./Migrations/070_UserMemory.ts";
import Campfire0071 from "./Migrations/071_ScheduledTaskThreadOrigin.ts";

import Campfire0044 from "./Migrations/044_ProjectionThreadSideThreads.ts";
import Campfire0045 from "./Migrations/045_ProjectionCollaborationIdentity.ts";
import Campfire0046 from "./Migrations/046_CanonicalizeProjectionSideThreads.ts";
import Campfire0047 from "./Migrations/047_ProjectionProjectsDefaultReviewModelSelection.ts";
import Campfire0048 from "./Migrations/048_ProjectionThreadsReviewKind.ts";

const Campfire0049 = Migration0039.pipe(Effect.andThen(Migration0043));
const Campfire0050 = Migration0034.pipe(
  Effect.andThen(Migration0035),
  Effect.andThen(Migration0036),
  Effect.andThen(Migration0037),
  Effect.andThen(Migration0038),
  Effect.andThen(Migration0039),
  Effect.andThen(Migration0043),
);

// Upstream migrations 62-98 run as Campfire ids 72-108.
import Migration0062 from "./Migrations/062_ThreadFailureLookupIndex.ts";
import Migration0063 from "./Migrations/063_DropUnusedV1Projections.ts";
import Migration0064 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";
import Migration0065 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";
import Migration0066 from "./Migrations/066_RepairClientSettlementTimestamps.ts";
import Migration0067 from "./Migrations/067_WebhookDedupe.ts";
import Migration0068 from "./Migrations/068_ShellStopRequestIndex.ts";
import Migration0069 from "./Migrations/069_ThreadMessageSearch.ts";
import Migration0070 from "./Migrations/070_PeerLinks.ts";
import Migration0071 from "./Migrations/071_PeerLinkFence.ts";
import Migration0072 from "./Migrations/072_WaitingLinkRequestIndex.ts";
import Migration0073 from "./Migrations/073_ActiveTurnItemIndexes.ts";
import Migration0074 from "./Migrations/074_ExcludeAttachmentPlaceholdersFromSearch.ts";
import Migration0075 from "./Migrations/075_SubagentDeliveryState.ts";
import Migration0076 from "./Migrations/076_ProjectionProjectsPinArchive.ts";
import Migration0077 from "./Migrations/077_RepairBooleanSettledOverride.ts";
import Migration0078 from "./Migrations/078_DropOrchestrationEventCorrelationIndex.ts";
import Migration0079 from "./Migrations/079_DelegatedRecoveryIndexes.ts";
import Migration0080 from "./Migrations/080_ScheduledTaskThreadMode.ts";
import Migration0081 from "./Migrations/081_ProjectionMessageSearchText.ts";
import Migration0082 from "./Migrations/082_TurnItemConversationIndex.ts";
import Migration0083 from "./Migrations/083_CommandReadIndexes.ts";
import Migration0084 from "./Migrations/084_LastExecutedRunIndex.ts";
import Migration0085 from "./Migrations/085_TurnItemCounts.ts";
import Migration0086 from "./Migrations/086_QueuedTurnInputIndex.ts";
import Migration0087 from "./Migrations/087_ProjectionProjectsCustomTitle.ts";
import Migration0088 from "./Migrations/088_TurnItemTypeStatusIndex.ts";
import Migration0089 from "./Migrations/089_ShellThreadReadIndexes.ts";
import Migration0090 from "./Migrations/090_AuthConnectDevices.ts";
import Migration0091 from "./Migrations/091_AuthConnectDeniedRequests.ts";
import Migration0092 from "./Migrations/092_QueuedTurnInputIndexJsonValid.ts";
import Migration0093 from "./Migrations/093_ProviderTurnAttemptIndex.ts";
import Migration0094 from "./Migrations/094_TurnItemMessageOrdinalIndex.ts";
import Migration0095 from "./Migrations/095_TurnItemInlineWorkOutput.ts";
import Migration0096 from "./Migrations/096_RepairStaleTitleRegeneration.ts";
import Migration0097 from "./Migrations/097_IssueTrackerBindings.ts";
import Migration0098 from "./Migrations/098_ActiveShellIndexIndexes.ts";

const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "ProjectionThreadSideThreads", Campfire0044],
  [45, "ProjectionCollaborationIdentity", Campfire0045],
  [46, "CanonicalizeProjectionSideThreads", Campfire0046],
  [47, "ProjectionProjectsDefaultReviewModelSelection", Campfire0047],
  [48, "ProjectionThreadsReviewKind", Campfire0048],
  [49, "ReconcileCollidedMigrationHistory", Campfire0049],
  [50, "ReconcileAllCollidedMigrationHistory", Campfire0050],
  [51, "ProjectionProjectsAutoPull", Migration0045],
  [52, "RepairAutomaticSettlementTimestamps", Migration0046],
  [53, "ProjectionProjectIcon", Migration0047],
  [54, "ProjectionThreadBranchPullRequest", Migration0048],
  [55, "ProjectionThreadsActiveOrderKey", Migration0049],
  [56, "ProjectionThreadPullRequests", Migration0050],
  [57, "ProjectionThreadMessageContext", Migration0051],
  [58, "ProjectionThreadTitleState", Migration0052],
  [59, "PullRequestFilesViewed", Migration0053],
  [60, "ProjectionThreadsAutoSettleDisabledAt", Migration0054],
  // Upstream V2 preview ledgers are reconciled to Campfire IDs before migrating.
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [61, "OrchestrationV2", Migration0055],
  [62, "RemoveRedundantProjectionIndexes", Migration0056],
  [63, "ScheduledTaskWebhooks", Migration0057],
  [64, "WebhookRelayDeliveries", Migration0058],
  [65, "McpAppModelContext", Migration0059],
  [66, "ThreadSnapshotWindowIndexes", Migration0060],
  [67, "PullRequestReviewGuides", Migration0061],
  [68, "CampfireV2Collaboration", Campfire0068],
  [69, "AuthSessionEmail", Campfire0069],
  [70, "UserMemory", Campfire0070],
  [71, "ScheduledTaskThreadOrigin", Campfire0071],
  [72, "ThreadFailureLookupIndex", Migration0062],
  [73, "DropUnusedV1Projections", Migration0063],
  [74, "CanonicalizeThreadPullRequestLinks", Migration0064],
  [75, "CodexUsageNativeTurnIndex", Migration0065],
  [76, "RepairClientSettlementTimestamps", Migration0066],
  [77, "WebhookDedupe", Migration0067],
  [78, "ShellStopRequestIndex", Migration0068],
  [79, "ThreadMessageSearch", Migration0069],
  [80, "PeerLinks", Migration0070],
  [81, "PeerLinkFence", Migration0071],
  [82, "WaitingLinkRequestIndex", Migration0072],
  [83, "ActiveTurnItemIndexes", Migration0073],
  [84, "ExcludeAttachmentPlaceholdersFromSearch", Migration0074],
  [85, "SubagentDeliveryState", Migration0075],
  [86, "ProjectionProjectsPinArchive", Migration0076],
  [87, "RepairBooleanSettledOverride", Migration0077],
  [88, "DropOrchestrationEventCorrelationIndex", Migration0078],
  [89, "DelegatedRecoveryIndexes", Migration0079],
  [90, "ScheduledTaskThreadMode", Migration0080],
  [91, "ProjectionMessageSearchText", Migration0081],
  [92, "TurnItemConversationIndex", Migration0082],
  [93, "CommandReadIndexes", Migration0083],
  [94, "LastExecutedRunIndex", Migration0084],
  [95, "TurnItemCounts", Migration0085],
  [96, "QueuedTurnInputIndex", Migration0086],
  [97, "ProjectionProjectsCustomTitle", Migration0087],
  [98, "TurnItemTypeStatusIndex", Migration0088],
  [99, "ShellThreadReadIndexes", Migration0089],
  [100, "AuthConnectDevices", Migration0090],
  [101, "AuthConnectDeniedRequests", Migration0091],
  [102, "QueuedTurnInputIndexJsonValid", Migration0092],
  [103, "ProviderTurnAttemptIndex", Migration0093],
  [104, "TurnItemMessageOrdinalIndex", Migration0094],
  [105, "TurnItemInlineWorkOutput", Migration0095],
  [106, "RepairStaleTitleRegeneration", Migration0096],
  [107, "IssueTrackerBindings", Migration0097],
  [108, "ActiveShellIndexIndexes", Migration0098],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

// V2's schema migrations start at 61 after the legacy schema migrations.
const FIRST_V2_MIGRATION_ID = 61;

export function skippedV2Migrations(
  recorded: ReadonlyArray<{ readonly id: number; readonly name: string }>,
  throughId?: number,
): string[] {
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.id));
  const recordedNames = new Map(recorded.map((row) => [row.id, row.name]));
  return migrationManifest.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    return recordedName === name ? [] : [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
}

// Migrators skip ids up to the highest recorded; reject collisions that would skip V2 schema.
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const skipped = skippedV2Migrations(
    recorded.map((row) => ({ id: row.migration_id, name: row.name })),
    throughId,
  );
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

const latestMigrationId = Math.max(...migrationEntries.map(([id]) => id));

// Mirrors the Migrator, which runs only ids above the highest recorded, plus the V2-preview reconciliation.
export const hasPendingMigrations = Effect.fn("hasPendingMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return true;
  const rows = yield* sql<{ readonly latestId: number | null; readonly previewRows: number }>`
    SELECT
      MAX(migration_id) AS latestId,
      SUM(name = 'OrchestrationV2' AND migration_id IN (59, 60)) AS previewRows
    FROM effect_sql_migrations
  `;
  const row = rows[0];
  return (row?.latestId ?? 0) < latestMigrationId || (row?.previewRows ?? 0) > 0;
});

const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const historySql = yield* SqlClient.SqlClient;
  const ledgerExists =
    yield* historySql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (ledgerExists.length > 0) {
    const upstreamHistory =
      yield* historySql`SELECT migration_id FROM effect_sql_migrations WHERE name = 'OrchestrationV2' AND migration_id < 59`;
    if (upstreamHistory.length > 0)
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message:
          "This database has an upstream V2 migration ledger. Campfire needs an explicit ledger conversion before upgrading it.",
      });
  }
  // The desktop waits past its readiness budget until the finished line follows this one.
  const hasPending = yield* hasPendingMigrations();
  if (hasPending) yield* Effect.log(DATABASE_MIGRATIONS_STARTED_MESSAGE);
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  // The reconcile takes the write lock; CLI startup must not contend with the server for a no-op.
  const previewMigrations = includesV2 && hasPending ? yield* reconcileV2PreviewMigration() : [];
  if (includesV2) {
    yield* assertV2MigrationsCanRun(toMigrationInclusive);
  }
  const sql = yield* SqlClient.SqlClient;
  const ledger = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  const [latest] =
    ledger.length === 0
      ? []
      : yield* sql<{
          readonly id: number | null;
        }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
  const latestRecordedId = latest?.id ?? 0;
  const pending = migrationEntries.filter(
    ([id]) =>
      id > latestRecordedId && (toMigrationInclusive === undefined || id <= toMigrationInclusive),
  );
  // One transaction per migration: an index build on a large database can take minutes, and a
  // restart then resumes after the last finished migration instead of rolling all of them back.
  const executedMigrations: Array<readonly [id: number, name: string]> = [...previewMigrations];
  for (const [index, [id, name]] of pending.entries()) {
    if (latestRecordedId > 0) {
      yield* Effect.log(DATABASE_MIGRATION_PROGRESS_MESSAGE).pipe(
        Effect.annotateLogs({
          migration: `${id}_${name}`,
          progress: `${index + 1} of ${pending.length}`,
        }),
      );
    }
    executedMigrations.push(...(yield* run({ loader: makeMigrationLoader(id) })));
  }
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log(DATABASE_MIGRATIONS_FINISHED_MESSAGE).pipe(Effect.annotateLogs({ migrations }));

  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  return executedMigrations;
});
