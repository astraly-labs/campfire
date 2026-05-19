import type { HelixPathMapping } from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

interface DraftMapping {
  readonly remotePrefix: string;
  readonly localPrefix: string;
}

function isCommittable(draft: DraftMapping): boolean {
  return draft.remotePrefix.trim().length > 0 && draft.localPrefix.trim().length > 0;
}

// Inline editor for the Helix path mappings list. Persists on blur of a
// committable row so partial typing never overwrites the persisted list.
export function HelixPathMappingsControl({
  mappings,
  onChange,
}: {
  mappings: ReadonlyArray<HelixPathMapping>;
  onChange: (next: ReadonlyArray<HelixPathMapping>) => void;
}) {
  const [draft, setDraft] = useState<DraftMapping>({ remotePrefix: "", localPrefix: "" });

  const commitExisting = (index: number, patch: Partial<HelixPathMapping>) => {
    const next = mappings.map((m, i) => (i === index ? { ...m, ...patch } : m));
    onChange(next);
  };

  const removeAt = (index: number) => {
    onChange(mappings.filter((_, i) => i !== index));
  };

  const addDraft = () => {
    if (!isCommittable(draft)) return;
    onChange([
      ...mappings,
      {
        remotePrefix: draft.remotePrefix.trim(),
        localPrefix: draft.localPrefix.trim(),
      },
    ]);
    setDraft({ remotePrefix: "", localPrefix: "" });
  };

  return (
    <div className="w-full space-y-2 pb-3.5">
      {mappings.length === 0 ? (
        <p className="text-xs text-muted-foreground/70">
          No mappings yet — add one below to enable the Helix entry in the Open menu.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {mappings.map((mapping, index) => (
            <li
              key={`${mapping.remotePrefix}::${index}`}
              className="flex flex-col gap-1.5 sm:flex-row sm:items-center"
            >
              <Input
                aria-label="Remote prefix"
                value={mapping.remotePrefix}
                placeholder="/Users/shared/work"
                onChange={(e) => commitExisting(index, { remotePrefix: e.target.value })}
                className="flex-1 font-mono text-xs"
              />
              <span className="text-muted-foreground" aria-hidden>
                →
              </span>
              <Input
                aria-label="Local prefix"
                value={mapping.localPrefix}
                placeholder="/Users/me/sshfs/work"
                onChange={(e) => commitExisting(index, { localPrefix: e.target.value })}
                className="flex-1 font-mono text-xs"
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove mapping ${mapping.remotePrefix}`}
                onClick={() => removeAt(index)}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
        <Input
          aria-label="New remote prefix"
          value={draft.remotePrefix}
          placeholder="/Users/shared/work"
          onChange={(e) => setDraft((d) => ({ ...d, remotePrefix: e.target.value }))}
          className="flex-1 font-mono text-xs"
        />
        <span className="text-muted-foreground" aria-hidden>
          →
        </span>
        <Input
          aria-label="New local prefix"
          value={draft.localPrefix}
          placeholder="/Users/me/sshfs/work"
          onChange={(e) => setDraft((d) => ({ ...d, localPrefix: e.target.value }))}
          className="flex-1 font-mono text-xs"
        />
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Add Helix path mapping"
          disabled={!isCommittable(draft)}
          onClick={addDraft}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
