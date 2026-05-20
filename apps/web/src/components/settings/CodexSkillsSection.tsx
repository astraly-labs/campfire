"use client";

import { ExternalLinkIcon } from "lucide-react";
import { useCallback, useMemo } from "react";
import type { ProviderInstanceId, ServerProviderSkill } from "@t3tools/contracts";

import { ensureLocalApi } from "../../localApi";
import { openInPreferredEditor } from "../../editorPreferences";
import {
  formatProviderSkillDisplayName,
  formatProviderSkillInstallSource,
} from "../../providerSkillPresentation";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface CodexSkillsSectionProps {
  readonly instanceId: ProviderInstanceId;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly disabledSkills: ReadonlyArray<string>;
  readonly onDisabledSkillsChange: (next: ReadonlyArray<string>) => void;
}

export function CodexSkillsSection({
  instanceId,
  skills,
  disabledSkills,
  onDisabledSkillsChange,
}: CodexSkillsSectionProps) {
  const disabledSet = useMemo(() => new Set(disabledSkills), [disabledSkills]);

  const sortedSkills = useMemo(
    () =>
      [...skills].sort((a, b) =>
        formatProviderSkillDisplayName(a).localeCompare(formatProviderSkillDisplayName(b)),
      ),
    [skills],
  );

  const handleToggle = (skillName: string, nextEnabled: boolean) => {
    if (nextEnabled) {
      onDisabledSkillsChange(disabledSkills.filter((name) => name !== skillName));
      return;
    }
    if (disabledSet.has(skillName)) return;
    onDisabledSkillsChange([...disabledSkills, skillName]);
  };

  const handleOpenInEditor = useCallback(async (skillPath: string) => {
    try {
      await openInPreferredEditor(ensureLocalApi(), skillPath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't open skill in editor",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  return (
    <div className="border-t border-border/60 px-4 py-3 sm:px-5">
      <div className="text-xs font-medium text-foreground">Skills</div>
      <div className="mt-1 text-xs text-muted-foreground">
        {skills.length === 0
          ? "No skills detected. Drop a SKILL.md into ~/.codex/skills/ to surface it here."
          : `${skills.length} skill${skills.length === 1 ? "" : "s"} discovered. Disabled skills are hidden from the / autocomplete in the composer.`}
      </div>
      {sortedSkills.length > 0 ? (
        <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto pb-1">
          {sortedSkills.map((skill) => {
            const enabled = !disabledSet.has(skill.name);
            const display = formatProviderSkillDisplayName(skill);
            const description = skill.shortDescription ?? skill.description ?? "";
            const sourceLabel = formatProviderSkillInstallSource(skill);
            return (
              <li
                key={`${instanceId}:${skill.path}`}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs text-foreground/90">{display}</span>
                    {sourceLabel ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {sourceLabel}
                      </span>
                    ) : null}
                  </div>
                  {description ? (
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                      {description}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                          aria-label={`Open ${display} in editor`}
                          onClick={() => void handleOpenInEditor(skill.path)}
                        />
                      }
                    >
                      <ExternalLinkIcon className="size-3" />
                    </TooltipTrigger>
                    <TooltipPopup side="top">Open SKILL.md in editor</TooltipPopup>
                  </Tooltip>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(value: boolean) => handleToggle(skill.name, value)}
                    aria-label={enabled ? `Disable ${display}` : `Enable ${display}`}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
