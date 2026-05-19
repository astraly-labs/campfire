import { EditorId, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import {
  applySshUsernameToHost,
  editorSupportsRemoteSshLaunch,
  REMOTE_SSH_EDITOR_IDS,
  resolveRemoteSshHostFromLocation,
  resolveRemoteSshLaunchUrl,
  shouldUseRemoteSshLaunch,
} from "../../remoteEditorLaunch";
import { readPrimaryEnvironmentDescriptor } from "../../environments/primary";
import { useSettings } from "../../hooks/useSettings";
import { buildHelixUrl, translateHelixPath } from "../../helixPathTranslation";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import {
  AntigravityIcon,
  CursorIcon,
  HelixIcon,
  Icon,
  KiroIcon,
  TraeIcon,
  VisualStudioCode,
  VisualStudioCodeInsiders,
  VSCodium,
  Zed,
} from "../Icons";
import {
  AquaIcon,
  CLionIcon,
  DataGripIcon,
  DataSpellIcon,
  GoLandIcon,
  IntelliJIdeaIcon,
  PhpStormIcon,
  PyCharmIcon,
  RiderIcon,
  RubyMineIcon,
  RustRoverIcon,
  WebStormIcon,
} from "../JetBrainsIcons";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

const resolveOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<{ label: string; Icon: Icon; value: EditorId }> = [
    {
      label: "Cursor",
      Icon: CursorIcon,
      value: "cursor",
    },
    {
      label: "Trae",
      Icon: TraeIcon,
      value: "trae",
    },
    {
      label: "Kiro",
      Icon: KiroIcon,
      value: "kiro",
    },
    {
      label: "VS Code",
      Icon: VisualStudioCode,
      value: "vscode",
    },
    {
      label: "VS Code Insiders",
      Icon: VisualStudioCodeInsiders,
      value: "vscode-insiders",
    },
    {
      label: "VSCodium",
      Icon: VSCodium,
      value: "vscodium",
    },
    {
      label: "Zed",
      Icon: Zed,
      value: "zed",
    },
    {
      label: "Antigravity",
      Icon: AntigravityIcon,
      value: "antigravity",
    },
    {
      label: "IntelliJ IDEA",
      Icon: IntelliJIdeaIcon,
      value: "idea",
    },
    {
      label: "Aqua",
      Icon: AquaIcon,
      value: "aqua",
    },
    {
      label: "CLion",
      Icon: CLionIcon,
      value: "clion",
    },
    {
      label: "DataGrip",
      Icon: DataGripIcon,
      value: "datagrip",
    },
    {
      label: "DataSpell",
      Icon: DataSpellIcon,
      value: "dataspell",
    },
    {
      label: "GoLand",
      Icon: GoLandIcon,
      value: "goland",
    },
    {
      label: "PhpStorm",
      Icon: PhpStormIcon,
      value: "phpstorm",
    },
    {
      label: "PyCharm",
      Icon: PyCharmIcon,
      value: "pycharm",
    },
    {
      label: "Rider",
      Icon: RiderIcon,
      value: "rider",
    },
    {
      label: "RubyMine",
      Icon: RubyMineIcon,
      value: "rubymine",
    },
    {
      label: "RustRover",
      Icon: RustRoverIcon,
      value: "rustrover",
    },
    {
      label: "WebStorm",
      Icon: WebStormIcon,
      value: "webstorm",
    },
    {
      label: "Helix",
      Icon: HelixIcon,
      value: "helix",
    },
    {
      label: isMacPlatform(platform)
        ? "Finder"
        : isWindowsPlatform(platform)
          ? "Explorer"
          : "Files",
      Icon: FolderClosedIcon,
      value: "file-manager",
    },
  ];
  return baseOptions.filter((option) => availableEditors.includes(option.value));
};

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors,
  openInCwd,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
}) {
  const helixPathMappings = useSettings((s) => s.helixPathMappings);
  const isRemoteBrowser = shouldUseRemoteSshLaunch();
  // The backend exposes its OS user via the environment descriptor — prepend
  // it so the SSH-remote authority targets the account that owns the server,
  // not whatever local user the viewer is logged in as.
  const sshUsername = isRemoteBrowser
    ? (readPrimaryEnvironmentDescriptor()?.sshUsername ?? null)
    : null;
  const sshHost = isRemoteBrowser
    ? applySshUsernameToHost(resolveRemoteSshHostFromLocation(), sshUsername)
    : "";
  // Some editors don't need to be present on the backend at all:
  //   - Helix (client-launched via `helix://` + a path mapping)
  //   - Cursor / VS Code family in remote-SSH mode, where the browser
  //     hands the OS a `cursor://vscode-remote/ssh-remote+host/...` URL
  //     and the *local* editor connects back over SSH-remote.
  // The server only reports editors it can spawn itself, so we splice
  // these in client-side when their preconditions are met.
  const effectiveAvailableEditors = useMemo<ReadonlyArray<EditorId>>(() => {
    const set = new Set<EditorId>(availableEditors);
    if (helixPathMappings.length > 0) set.add("helix");
    if (isRemoteBrowser) for (const id of REMOTE_SSH_EDITOR_IDS) set.add(id);
    return Array.from(set);
  }, [availableEditors, helixPathMappings.length, isRemoteBrowser]);
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(effectiveAvailableEditors);
  const options = useMemo(
    () => resolveOptions(navigator.platform, effectiveAvailableEditors),
    [effectiveAvailableEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;
  // Helix has its own client-side launch path (helix:// URL scheme +
  // sshfs-mounted translation) that works regardless of remote backend, so
  // it shouldn't be treated as "remote-unsupported".
  const editorWorksFromRemoteBrowser = useCallback(
    (editor: EditorId) => editor === "helix" || editorSupportsRemoteSshLaunch(editor),
    [],
  );
  const preferredEditorBlockedByRemote =
    isRemoteBrowser && preferredEditor !== null && !editorWorksFromRemoteBrowser(preferredEditor);

  const launchEditor = useCallback(
    (editor: EditorId) => {
      if (!openInCwd) return false;

      if (editor === "helix") {
        const localPath = translateHelixPath(openInCwd, helixPathMappings);
        if (!localPath) {
          console.warn("[Helix] no path mapping matches", openInCwd);
          return false;
        }
        window.location.assign(buildHelixUrl(localPath));
        return true;
      }

      if (isRemoteBrowser) {
        const url = resolveRemoteSshLaunchUrl({ editor, cwd: openInCwd, sshHost });
        if (!url) return false;
        // Navigate the top window so the OS resolves the cursor:// / vscode:// handler.
        // Using assign() rather than window.open keeps us inside the same tab and avoids popup blockers.
        window.location.assign(url);
        return true;
      }

      const api = readLocalApi();
      if (!api) return false;
      void api.shell.openInEditor(openInCwd, editor);
      return true;
    },
    [openInCwd, isRemoteBrowser, sshHost, helixPathMappings],
  );

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      if (!launchEditor(editor)) return;
      setPreferredEditor(editor);
    },
    [preferredEditor, launchEditor, setPreferredEditor],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!openInCwd || !preferredEditor) return;
      if (isRemoteBrowser && !editorWorksFromRemoteBrowser(preferredEditor)) return;

      e.preventDefault();
      launchEditor(preferredEditor);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    preferredEditor,
    keybindings,
    openInCwd,
    isRemoteBrowser,
    launchEditor,
    editorWorksFromRemoteBrowser,
  ]);

  const remoteDisabledTitle = isRemoteBrowser
    ? `Only Cursor, VS Code-family editors, and Zed can open over SSH-remote (host: ${sshHost || "unknown"}).`
    : undefined;
  const primaryButtonTitle = preferredEditorBlockedByRemote ? remoteDisabledTitle : undefined;

  return (
    <Group aria-label="Subscription actions">
      <Button
        size="xs"
        variant="outline"
        disabled={!preferredEditor || !openInCwd || preferredEditorBlockedByRemote}
        onClick={() => openInEditor(preferredEditor)}
        title={primaryButtonTitle}
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @3xl/header-actions:block" />
      <Menu>
        <MenuTrigger render={<Button aria-label="Copy options" size="icon-xs" variant="outline" />}>
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
          {options.map(({ label, Icon, value }) => {
            const remoteUnsupported = isRemoteBrowser && !editorWorksFromRemoteBrowser(value);
            return (
              <MenuItem
                key={value}
                disabled={remoteUnsupported}
                title={remoteUnsupported ? remoteDisabledTitle : undefined}
                onClick={() => openInEditor(value)}
              >
                <Icon aria-hidden="true" className="text-muted-foreground" />
                {label}
                {remoteUnsupported && (
                  <span className="ml-auto text-muted-foreground text-xs">no remote-SSH</span>
                )}
                {!remoteUnsupported &&
                  value === preferredEditor &&
                  openFavoriteEditorShortcutLabel && (
                    <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
                  )}
              </MenuItem>
            );
          })}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
