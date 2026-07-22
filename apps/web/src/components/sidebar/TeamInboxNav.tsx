import { useLocation, useNavigate } from "@tanstack/react-router";
import { InboxIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { useGoogleTeam } from "../../collaboration/googleTeam";
import { countUnreadTeamInboxItems, deriveTeamInboxItems } from "../../inbox/teamInbox";
import { useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";

export function TeamInboxNav() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentId = usePrimaryEnvironmentId();
  const team = useGoogleTeam(environmentId);
  const threads = useThreadShells();
  const items = useMemo(
    () =>
      deriveTeamInboxItems({
        threads,
        environmentId,
        currentSubject: team.current?.subject ?? null,
      }),
    [environmentId, team.current?.subject, threads],
  );
  const unreadCount = countUnreadTeamInboxItems(items);
  const openInbox = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/inbox" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarGroup className="px-2 py-0">
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            size="sm"
            isActive={pathname === "/inbox"}
            className="gap-2 px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
            onClick={openInbox}
          >
            <InboxIcon className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate text-left">Inbox</span>
            {unreadCount > 0 ? (
              <span className="min-w-5 rounded-full bg-primary px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none text-primary-foreground tabular-nums">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            ) : null}
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}
