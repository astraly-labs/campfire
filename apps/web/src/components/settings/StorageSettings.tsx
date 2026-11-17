import type {
  StorageCleanupReport,
  StorageCleanupSettings,
  WorktreeCleanupRules,
} from "@t3tools/contracts";
import { resolveWorktreeCleanup } from "@t3tools/shared/projectSettings";
import { Fragment, useMemo, useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/reactivity";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { formatBytes } from "../../lib/formatBytes";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { SettingsGroup } from "./SettingsGroup";
import type { ScopedSettingsTarget } from "./scopedSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useClearScopedSettings,
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function WorktreesDirectoryRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreesDirectory"]);
  const edited = useRef(false);
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.worktreesDirectory !== true,
    )
  )
    return null;
  const scopeKey = targets.map((target) => target.environmentId).join(",");

  return (
    <SettingsRow
      {...searchableSetting("storage-worktrees-location")}
      description={
        "Folder where new worktrees are created, on any drive, such as D:\\worktrees or ~/worktrees. Existing worktrees stay where they are. Leave empty to use the T3 home folder."
      }
      serverScoped
      settingKeys={["worktreesDirectory"]}
      resetAction={
        mixed || settings.worktreesDirectory !== "" ? (
          <SettingResetButton
            label="worktree location"
            onClick={() => updateSettings({ worktreesDirectory: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${settings.worktreesDirectory}`}
          aria-label="Worktree location"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? "Mixed" : "Default"}
          defaultValue={mixed ? "" : settings.worktreesDirectory}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.worktreesDirectory))
              updateSettings({ worktreesDirectory: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}

function RetentionControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [savedValue, setSavedValue] = useState(value);
  if (savedValue !== value) {
    setSavedValue(value);
    setDraft(value);
  }

  return (
    <div className="flex items-center gap-3">
      {value !== null ? (
        <NumberField
          value={draft}
          min={1}
          max={3650}
          step={1}
          size="sm"
          className="w-auto"
          onValueChange={setDraft}
          onValueCommitted={(next) => {
            if (next === null) setDraft(value);
            else {
              const days = Math.min(3650, Math.max(1, Math.round(next)));
              setDraft(days);
              onChange(days);
            }
          }}
        >
          <NumberFieldGroup>
            <NumberFieldDecrement aria-label={`Decrease ${label}`} />
            <NumberFieldInput
              aria-label={`${label} in days`}
              size={new Intl.NumberFormat().format(draft ?? value).length}
              className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
            />
            <span aria-hidden="true" className="self-center pr-2 text-xs">
              days
            </span>
            <NumberFieldIncrement aria-label={`Increase ${label}`} />
          </NumberFieldGroup>
        </NumberField>
      ) : (
        <span className="text-xs text-muted-foreground">Off</span>
      )}
      <Switch
        aria-label={label}
        checked={value !== null}
        onCheckedChange={(enabled) => onChange(enabled ? 8 : null)}
      />
    </div>
  );
}

const KEEP_WHEN_LABELS = {
  "any-local-files": "Any local files",
  "uncommitted-changes": "Uncommitted changes",
  "tracked-changes": "Edited tracked files",
} as const;

function CleanupResults({
  report,
  environmentLabel,
}: {
  report: StorageCleanupReport;
  environmentLabel: string | undefined;
}) {
  return (
    <>
      {report.entries.map((entry, index) => {
        const name =
          entry.kind === "worktree"
            ? (entry.path?.split(/[\\/]/).findLast(Boolean) ?? "Worktrees")
            : entry.kind === "logs"
              ? "Rotated logs"
              : "Browser artifacts";
        return (
          <SettingsRow
            key={`${entry.path ?? entry.kind}:${entry.threadId ?? index}`}
            title={environmentLabel ? `${environmentLabel}: ${name}` : name}
            description={
              <span
                className={`wrap-anywhere ${entry.outcome === "failed" ? "text-destructive" : ""}`}
              >
                {entry.threadTitle && entry.threadTitle !== name ? `${entry.threadTitle}. ` : ""}
                {entry.reason}
              </span>
            }
            control={
              entry.outcome === "removed" && (
                <span className="text-xs text-muted-foreground">
                  {[
                    entry.kind !== "worktree" && entry.files !== null
                      ? `${entry.files.toLocaleString()} ${entry.files === 1 ? "file" : "files"}`
                      : null,
                    entry.bytes !== null ? formatBytes(entry.bytes) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              )
            }
          />
        );
      })}
      {report.omittedCount > 0 && (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          {environmentLabel ? `${environmentLabel}: ` : ""}
          {report.omittedCount.toLocaleString()} more results.
        </p>
      )}
      {report.entries.length === 0 && report.omittedCount === 0 && (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          {environmentLabel ? `${environmentLabel}: ` : ""}Nothing needed cleanup.
        </p>
      )}
    </>
  );
}

function CleanupSection() {
  useRelativeTimeTick(60_000);
  const { connectedEnvironments } = useSettingsScope();
  const [pending, setPending] = useState(false);
  const run = useAtomCommand(serverEnvironment.runStorageCleanup);
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.storageCleanupRun === true,
  );
  const state = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          connectedEnvironments.flatMap((environment) => {
            if (environment.serverConfig?.environment.capabilities.storageCleanupRun !== true)
              return [];
            const query = get(
              serverEnvironment.storageCleanupReport({
                environmentId: environment.environmentId,
                input: {},
              }),
            );
            return [
              {
                environmentId: environment.environmentId,
                allowed: get(
                  serverEnvironment.runStorageCleanup.permissionAtom(environment.environmentId),
                ),
                report: query._tag === "Success" ? query.value : null,
                loading: query.waiting,
                failed: query._tag === "Failure",
              },
            ];
          }),
        ),
      [connectedEnvironments],
    ),
  );
  const hasRules = supported.some((environment) => {
    const settings = environment.serverConfig?.settings;
    if (!settings) return false;
    const enabled = (rules: WorktreeCleanupRules) =>
      rules.worktreeAfterDays !== null ||
      rules.worktreeOnMerge ||
      rules.worktreeOnDelete ||
      rules.worktreeUnchanged;
    return (
      settings.storageCleanup.browserArtifactsAfterDays !== null ||
      settings.storageCleanup.logsAfterDays !== null ||
      enabled(resolveWorktreeCleanup(settings, null)) ||
      Object.values(settings.projectSettingsOverrides).some(
        (override) =>
          override.worktreeCleanup?.mode === "custom" && enabled(override.worktreeCleanup.rules),
      )
    );
  });
  if (supported.length === 0) return null;
  const summaries = supported.map((environment) => {
    const query = state.find((entry) => entry.environmentId === environment.environmentId);
    const report = query?.report ?? null;
    return {
      environment,
      report,
      description: report
        ? `Last run ${formatRelativeTimeLabel(report.finishedAt)}. ${formatBytes(report.bytesFreed)} recovered.${report.counts.failed > 0 ? ` ${report.counts.failed} ${report.counts.failed === 1 ? "item" : "items"} couldn't be removed.` : ""}`
        : query?.failed
          ? "Could not load the last run."
          : query?.loading
            ? "Loading last run…"
            : "Cleanup hasn't run yet.",
    };
  });
  const deleteNow = async () => {
    if (pending) return;
    setPending(true);
    try {
      await Promise.all(
        supported
          .filter((environment) =>
            state.some(
              (entry) => entry.environmentId === environment.environmentId && entry.allowed,
            ),
          )
          .map(async (environment) => {
            const result = await run({ environmentId: environment.environmentId, input: {} });
            if (result._tag === "Success") {
              const failures = result.value.entries.filter((entry) => entry.outcome === "failed");
              if (failures.length > 0)
                toastManager.add({
                  type: "error",
                  title: `Cleanup failed on ${environment.label}`,
                  description: failures[0]!.reason,
                });
            } else if (!isAtomCommandInterrupted(result)) {
              toastManager.add({
                type: "error",
                title: `Could not run cleanup on ${environment.label}`,
                description: String(squashAtomCommandFailure(result)),
              });
            }
          }),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsSection id="storage-cleanup" title="Cleanup" variant="plain">
      <SettingsGroup>
        <SettingsRow
          {...searchableSetting("storage-delete-now")}
          description={
            <span>
              {!hasRules
                ? "Turn on a cleanup rule to use this."
                : summaries.map(({ environment, description }) => (
                    <span key={environment.environmentId} className="block">
                      {supported.length > 1 ? `${environment.label}: ` : ""}
                      {description}
                    </span>
                  ))}
            </span>
          }
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={pending || !hasRules || !state.some((entry) => entry.allowed)}
              onClick={() => void deleteNow()}
            >
              {pending ? "Deleting…" : "Delete now"}
            </Button>
          }
        />
      </SettingsGroup>
      {summaries.some(({ report }) => report !== null) && (
        <FoldedSettingsSection
          id="storage-cleanup-last-run"
          title="Last run"
          headerPlacement="inside"
          summary={summaries
            .flatMap(({ environment, report }) =>
              report
                ? [
                    `${connectedEnvironments.length > 1 ? `${environment.label}: ` : ""}${report.counts.removed} removed, ${report.counts.kept} kept${report.counts.failed > 0 ? `, ${report.counts.failed} failed` : ""}`,
                  ]
                : [],
            )
            .join(" · ")}
        >
          {summaries.map(
            ({ environment, report }) =>
              report && (
                <CleanupResults
                  key={environment.environmentId}
                  report={report}
                  environmentLabel={
                    connectedEnvironments.length > 1 ? environment.label : undefined
                  }
                />
              ),
          )}
        </FoldedSettingsSection>
      )}
    </SettingsSection>
  );
}

const GIB = 1024 ** 3;
const VOLUME_ROLE_LABELS = {
  state: "Database and logs",
  worktrees: "Worktrees",
  "build-cache": "Build caches",
} as const;

function BuildCacheFoldersRow() {
  const { connectedEnvironments, targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const edited = useRef(false);
  const folders = settings.storageCleanup.buildCacheFolders;
  const mixed = targets.some(
    (target) => target.settings.storageCleanup.buildCacheFolders.join("\n") !== folders.join("\n"),
  );
  if (
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.buildCaches !== true,
    )
  )
    return null;
  const scopeKey = targets.map((target) => target.environmentId).join(",");

  return (
    <SettingsRow
      {...searchableSetting("storage-build-cache-folders")}
      status={mixed ? "Mixed across selected machines" : undefined}
      description="Folders that hold Cargo target folders, such as a shared CARGO_TARGET_DIR parent. One absolute path per line. Worktree target folders are found automatically."
      serverScoped
    >
      <div className="mt-3 max-w-2xl pb-3.5">
        <Textarea
          key={`${scopeKey}:${mixed}:${folders.join("\n")}`}
          aria-label="Build cache folders"
          autoCapitalize="none"
          spellCheck={false}
          rows={3}
          placeholder={mixed ? "Mixed" : "/Volumes/SSD/cargo-targets"}
          defaultValue={mixed ? "" : folders.join("\n")}
          onChange={() => {
            edited.current = true;
          }}
          onBlur={(event) => {
            const next = [
              ...new Set(
                event.target.value
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean),
              ),
            ];
            if (edited.current && (mixed || next.join("\n") !== folders.join("\n")))
              updateSettings({ storageCleanup: { buildCacheFolders: next } });
            edited.current = false;
          }}
        />
      </div>
    </SettingsRow>
  );
}

function DisksSection() {
  const { connectedEnvironments } = useSettingsScope();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const clear = useAtomCommand(serverEnvironment.clearBuildCaches);
  const state = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          connectedEnvironments.flatMap((environment) => {
            if (environment.serverConfig?.environment.capabilities.buildCaches !== true) return [];
            const query = get(
              serverEnvironment.storageUsage({
                environmentId: environment.environmentId,
                input: {},
              }),
            );
            return [
              {
                environment,
                allowed: get(
                  serverEnvironment.clearBuildCaches.permissionAtom(environment.environmentId),
                ),
                usage: query._tag === "Success" ? query.value : null,
                loading: query.waiting,
                failed: query._tag === "Failure",
              },
            ];
          }),
        ),
      [connectedEnvironments],
    ),
  );
  if (state.length === 0) return null;
  const prefix = (label: string) => (connectedEnvironments.length > 1 ? `${label}: ` : "");
  const clearable = state.flatMap(({ environment, usage, allowed }) =>
    allowed && usage ? [{ environment, caches: usage.buildCaches.filter((c) => !c.inUse) }] : [],
  );
  const clearableBytes = clearable.reduce(
    (total, { caches }) => total + caches.reduce((sum, cache) => sum + (cache.bytes ?? 0), 0),
    0,
  );
  const clearableCount = clearable.reduce((total, { caches }) => total + caches.length, 0);

  const clearNow = async () => {
    if (pending) return;
    setPending(true);
    try {
      await Promise.all(
        clearable.map(async ({ environment }) => {
          const result = await clear({ environmentId: environment.environmentId, input: {} });
          if (result._tag === "Success") {
            const failures = result.value.entries.filter((entry) => entry.outcome === "failed");
            toastManager.add(
              failures.length > 0
                ? {
                    type: "error",
                    title: `${failures.length} build ${failures.length === 1 ? "cache" : "caches"} couldn't be removed on ${environment.label}`,
                    description: `${failures[0]!.path}: ${failures[0]!.reason}`,
                  }
                : {
                    type: "success",
                    title: `${formatBytes(result.value.bytesFreed)} freed on ${environment.label}`,
                  },
            );
          } else if (!isAtomCommandInterrupted(result)) {
            toastManager.add({
              type: "error",
              title: `Could not clear build caches on ${environment.label}`,
              description: String(squashAtomCommandFailure(result)),
            });
          }
          appAtomRegistry.refresh(
            serverEnvironment.storageUsage({ environmentId: environment.environmentId, input: {} }),
          );
        }),
      );
    } finally {
      setPending(false);
      setConfirming(false);
    }
  };

  return (
    <SettingsSection id="storage-disks" title="Disks">
      {state.map(({ environment, usage, loading, failed }) => {
        if (!usage)
          return (
            <SettingsRow
              key={environment.environmentId}
              title={`${prefix(environment.label)}Disks`}
              description={failed ? "Could not read disk usage." : loading ? "Measuring…" : ""}
            />
          );
        const count = usage.buildCaches.length;
        const inUse = usage.buildCaches.filter((cache) => cache.inUse).length;
        const unmeasured = usage.buildCaches.filter((cache) => cache.bytes === null).length;
        return (
          <Fragment key={environment.environmentId}>
            {usage.volumes.map((volume) => (
              <SettingsRow
                key={volume.path}
                title={`${prefix(environment.label)}${VOLUME_ROLE_LABELS[volume.role]}`}
                description={<span className="wrap-anywhere">{volume.path}</span>}
                control={
                  <span className="text-xs text-muted-foreground">
                    {Math.floor(volume.freeBytes / GIB).toLocaleString()} GB free of{" "}
                    {Math.floor(volume.totalBytes / GIB).toLocaleString()} GB
                  </span>
                }
              />
            ))}
            {usage.unreadablePaths.map((folder) => (
              <SettingsRow
                key={`unreadable:${folder}`}
                title={`${prefix(environment.label)}Unreadable`}
                description={
                  <span className="wrap-anywhere text-destructive">
                    {folder} did not respond. Its drive may be frozen or unplugged.
                  </span>
                }
              />
            ))}
            <SettingsRow
              title={`${prefix(environment.label)}Build caches`}
              description={
                count === 0
                  ? "No build caches found."
                  : [
                      `${formatBytes(usage.buildCacheBytes)} in ${count} ${count === 1 ? "cache" : "caches"}.`,
                      inUse > 0 ? `${inUse} in use will be kept.` : null,
                      unmeasured > 0 ? `${unmeasured} unreadable.` : null,
                    ]
                      .filter(Boolean)
                      .join(" ")
              }
            />
          </Fragment>
        );
      })}
      <SettingsRow
        title="Clear build caches"
        description="Delete Cargo build output that is not in use. Caches built in the last 30 minutes or used by a running thread are kept."
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={pending || clearableCount === 0}
            onClick={() => setConfirming(true)}
          >
            Clear build caches
          </Button>
        }
      />
      <BuildCacheFoldersRow />
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!pending) setConfirming(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear build caches?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes {clearableCount} {clearableCount === 1 ? "cache" : "caches"} (
              {formatBytes(clearableBytes)}). They rebuild on the next compile, which will be
              slower.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={pending} onClick={() => void clearNow()}>
              {pending ? "Clearing…" : "Clear build caches"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}

export function StorageSettingsPanel() {
  const { scope, connectedEnvironments, targets, target } = useSettingsScope();
  const scopedSettings = useScopedSettings();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = {
    ...scopedSettings.storageCleanup,
    ...resolveWorktreeCleanup(scopedSettings, null),
  };
  const projectMode = (entry: ScopedSettingsTarget | null) =>
    entry?.sources.worktreeCleanup === "project"
      ? (entry.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit";
  const mode = projectMode(target);
  const mixedModes = targets.some((entry) => projectMode(entry) !== mode);
  const updateSettings = useUpdateScopedSettings();
  const clearSettings = useClearScopedSettings();
  const ruleStatus = (key: keyof StorageCleanupSettings) =>
    targets.some(
      (target) =>
        ({ ...target.settings.storageCleanup, ...resolveWorktreeCleanup(target.settings, null) })[
          key
        ] !== settings[key],
    )
      ? "Mixed across selected machines"
      : undefined;
  const update = (patch: Partial<StorageCleanupSettings>) =>
    updateSettings({ storageCleanup: patch });
  const updateWorktree = (patch: Partial<WorktreeCleanupRules>) =>
    isProjectScope
      ? updateSettings({ worktreeCleanup: { mode: "custom", rules: patch } })
      : update(patch);

  if (
    isProjectScope &&
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.projectWorktreeCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice target="all">
        Update the selected machines to configure project worktree cleanup.
      </SettingsScopeNotice>
    );
  }

  if (
    connectedEnvironments.some(
      (environment) => environment.serverConfig?.environment.capabilities.storageCleanup !== true,
    )
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        eligibleEnvironmentIds={connectedEnvironments
          .filter(
            (environment) =>
              environment.serverConfig?.environment.capabilities.storageCleanup === true,
          )
          .map((environment) => environment.environmentId)}
      >
        Update the selected environments to use storage cleanup, or choose a machine that supports
        it.
      </SettingsScopeNotice>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="storage-worktrees" title="Worktrees">
        {!isProjectScope && <WorktreesDirectoryRow />}
        {isProjectScope && (
          <SettingsRow
            title="Automatic worktree cleanup"
            description={
              mode === "off"
                ? "Keep this project's worktrees until you delete them manually."
                : mode === "custom"
                  ? "Use these rules for this project."
                  : "Use each machine's worktree cleanup settings."
            }
            serverScoped
            settingKeys={["worktreeCleanup"]}
            mixed={mixedModes}
            control={
              <Select
                value={mixedModes ? null : mode}
                onValueChange={(next) => {
                  if (next === "inherit") clearSettings(["worktreeCleanup"]);
                  else if (next === "off") updateSettings({ worktreeCleanup: { mode: "off" } });
                  else if (next === "custom")
                    updateSettings({ worktreeCleanup: { mode: "custom", rules: {} } });
                }}
              >
                <SelectTrigger size="sm" aria-label="Automatic worktree cleanup">
                  <SelectValue>
                    {mixedModes
                      ? "Mixed"
                      : mode === "inherit"
                        ? "Inherit"
                        : mode === "off"
                          ? "Off"
                          : "Custom"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="inherit">Inherit</SelectItem>
                  <SelectItem value="off">Off</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        )}
        {(!isProjectScope || (!mixedModes && mode === "custom")) && (
          <>
            <SettingsRow
              title="Delete worktrees with deleted threads"
              status={ruleStatus("worktreeOnDelete")}
              description="Remove unused worktrees when active or archived threads are deleted. Worktrees with local changes are kept."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="Delete worktrees with deleted threads"
                  checked={settings.worktreeOnDelete}
                  onCheckedChange={(worktreeOnDelete) => updateWorktree({ worktreeOnDelete })}
                />
              }
            />
            <SettingsRow
              title="Delete inactive worktrees"
              status={ruleStatus("worktreeAfterDays")}
              description="Remove worktrees after their threads have been inactive for this many days. Branches and thread history are kept."
              serverScoped={!isProjectScope}
              control={
                <RetentionControl
                  label="Delete inactive worktrees"
                  value={settings.worktreeAfterDays}
                  onChange={(worktreeAfterDays) => updateWorktree({ worktreeAfterDays })}
                />
              }
            />
            <SettingsRow
              title="Delete merged worktrees"
              status={ruleStatus("worktreeOnMerge")}
              description="Remove worktrees whose pull request is merged and whose commits are included in the default branch."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="Delete merged worktrees"
                  checked={settings.worktreeOnMerge}
                  onCheckedChange={(worktreeOnMerge) => updateWorktree({ worktreeOnMerge })}
                />
              }
            />
            <SettingsRow
              title="Delete unchanged worktrees"
              status={ruleStatus("worktreeUnchanged")}
              description="Remove worktrees with no commits beyond the default branch."
              serverScoped={!isProjectScope}
              control={
                <Switch
                  aria-label="Delete unchanged worktrees"
                  checked={settings.worktreeUnchanged}
                  onCheckedChange={(worktreeUnchanged) => updateWorktree({ worktreeUnchanged })}
                />
              }
            />
            {connectedEnvironments.every(
              (environment) =>
                environment.serverConfig?.environment.capabilities.storageCleanupRun === true,
            ) && (
              <SettingsRow
                {...searchableSetting("storage-worktree-keep-when")}
                status={ruleStatus("worktreeKeepWhen")}
                description={
                  settings.worktreeKeepWhen === "any-local-files"
                    ? "Includes ignored files, except node_modules."
                    : settings.worktreeKeepWhen === "tracked-changes"
                      ? "Deletes untracked and ignored files, including .env."
                      : "Keeps edits and untracked files. Deletes ignored files, including .env."
                }
                serverScoped={!isProjectScope}
                control={
                  <Select
                    value={ruleStatus("worktreeKeepWhen") ? null : settings.worktreeKeepWhen}
                    onValueChange={(next) => {
                      if (
                        next === "any-local-files" ||
                        next === "uncommitted-changes" ||
                        next === "tracked-changes"
                      )
                        updateWorktree({ worktreeKeepWhen: next });
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Keep worktrees with local changes">
                      <SelectValue>
                        {ruleStatus("worktreeKeepWhen")
                          ? "Mixed"
                          : KEEP_WHEN_LABELS[settings.worktreeKeepWhen]}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      <SelectItem value="any-local-files">Any local files</SelectItem>
                      <SelectItem value="uncommitted-changes">Uncommitted changes</SelectItem>
                      <SelectItem value="tracked-changes">Edited tracked files</SelectItem>
                    </SelectPopup>
                  </Select>
                }
              />
            )}
          </>
        )}
      </SettingsSection>

      {!isProjectScope && (
        <SettingsSection id="storage-artifacts" title="Artifacts and logs">
          <SettingsRow
            title="Delete old browser artifacts"
            status={ruleStatus("browserArtifactsAfterDays")}
            description="Delete saved browser captures after this many days. Older capture links will no longer open."
            serverScoped
            control={
              <RetentionControl
                label="Delete old browser artifacts"
                value={settings.browserArtifactsAfterDays}
                onChange={(browserArtifactsAfterDays) => update({ browserArtifactsAfterDays })}
              />
            }
          />
          <SettingsRow
            title="Delete old rotated logs"
            status={ruleStatus("logsAfterDays")}
            description="Delete inactive rotated log files after this many days. Current logs are kept."
            serverScoped
            control={
              <RetentionControl
                label="Delete old rotated logs"
                value={settings.logsAfterDays}
                onChange={(logsAfterDays) => update({ logsAfterDays })}
              />
            }
          />
        </SettingsSection>
      )}
      {!isProjectScope && <DisksSection />}
      {!isProjectScope && <CleanupSection />}
    </SettingsPageContainer>
  );
}
