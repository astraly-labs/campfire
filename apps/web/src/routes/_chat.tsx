import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect } from "react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { readEnvironmentApi } from "../environmentApi";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { useInboxLiveSync, useInboxStore } from "../inbox/inboxStore";
import { usePresenceLiveSync } from "../presence/presenceStore";
import { usePresenceHeartbeat } from "../presence/usePresenceHeartbeat";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import {
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
} from "../lib/chatThreadActions";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { resolveSidebarNewThreadEnvMode } from "~/components/Sidebar.logic";
import { useSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "~/rpc/serverState";

function ChatRouteGlobalShortcuts() {
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const selectedThreadKeysSize = useThreadSelectionStore((state) => state.selectedThreadKeys.size);
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread, routeThreadRef } =
    useHandleNewThread();
  const keybindings = useServerKeybindings();
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const appSettings = useSettings();

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });

      if (useCommandPaletteStore.getState().open) {
        return;
      }

      if (event.key === "Escape" && selectedThreadKeysSize > 0) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (command === "chat.newLocal") {
        event.preventDefault();
        event.stopPropagation();
        void startNewLocalThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
        return;
      }

      if (command === "chat.new") {
        event.preventDefault();
        event.stopPropagation();
        void startNewThreadFromContext({
          activeDraftThread,
          activeThread,
          defaultProjectRef,
          defaultThreadEnvMode: resolveSidebarNewThreadEnvMode({
            defaultEnvMode: appSettings.defaultThreadEnvMode,
          }),
          handleNewThread,
        });
      }
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    activeDraftThread,
    activeThread,
    clearSelection,
    handleNewThread,
    keybindings,
    defaultProjectRef,
    selectedThreadKeysSize,
    terminalOpen,
    appSettings.defaultThreadEnvMode,
  ]);

  return null;
}

function ChatInboxLifecycle() {
  // Wire the cross-route inbox feed so the sidebar badge stays live even
  // when the user isn't on `/inbox`. Mounted under `_chat` because the
  // route is auth-gated, so we never hit `inbox.list` before the WS upgrade.
  const environmentId = usePrimaryEnvironmentId();
  const api = environmentId ? readEnvironmentApi(environmentId) : undefined;
  const refresh = useInboxStore((state) => state.refresh);

  useEffect(() => {
    if (!api) return;
    void refresh(api);
  }, [api, refresh]);

  useInboxLiveSync(api);
  return null;
}

function ChatPresenceLifecycle() {
  // Wire the live presence stream + outbound heartbeat under `_chat` so the
  // ws upgrade has already happened. The hook below reads the current route
  // thread independently — no prop drilling required.
  const environmentId = usePrimaryEnvironmentId();
  const api = environmentId ? readEnvironmentApi(environmentId) : undefined;
  const { routeThreadRef } = useHandleNewThread();
  const parentThreadId = routeThreadRef?.threadId ?? null;

  usePresenceLiveSync(api);
  usePresenceHeartbeat({ api, parentThreadId });
  return null;
}

function ChatRouteLayout() {
  return (
    <>
      <ChatRouteGlobalShortcuts />
      <ChatInboxLifecycle />
      <ChatPresenceLifecycle />
      <Outlet />
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ChatRouteLayout,
});
