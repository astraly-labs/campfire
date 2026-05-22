/**
 * `/global` — workspace-wide Global chat. Single Slack-style channel shared
 * across every project / agent thread; not anchored to any specific agent
 * conversation. Reuses {@link DrawerBody} so we get the same composer,
 * mentions, GIFs, and reactions for free.
 */
import { GLOBAL_CHAT_SIDETHREAD_ID } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { HashIcon } from "lucide-react";

import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { usePrimaryEnvironmentId } from "../environments/primary";
import { DrawerBody } from "../sidethread/SideThreadDrawer";

function GlobalChatRouteView() {
  const environmentId = usePrimaryEnvironmentId();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <HashIcon className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Global chat</span>
        </header>

        {environmentId ? (
          <div className="flex min-h-0 flex-1">
            <DrawerBody
              environmentId={environmentId}
              parentThreadId={null}
              sideThreadId={GLOBAL_CHAT_SIDETHREAD_ID}
              onClose={() => {
                // Closing the global chat from inside DrawerBody is a no-op
                // on this standalone route — the user navigates away via
                // the sidebar instead.
              }}
              mode="sheet"
            />
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Connecting…
          </div>
        )}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/global")({
  component: GlobalChatRouteView,
});
