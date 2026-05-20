import { useCallback, type ComponentType } from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  ArrowLeftIcon,
  BotIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
  Settings2Icon,
  UserIcon,
} from "lucide-react";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";

import { useHostHealth } from "../../lib/hostHealthState";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HealthDot, HealthTooltipContent } from "./HealthStatusIndicator";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/identity"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/health"
  | "/settings/archived";

interface SettingsNavItem {
  readonly label: string;
  readonly to: SettingsSectionPath;
  readonly icon: ComponentType<{ className?: string }>;
}

export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Identity", to: "/settings/identity", icon: UserIcon },
  { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
  { label: "Providers", to: "/settings/providers", icon: BotIcon },
  { label: "Source Control", to: "/settings/source-control", icon: GitBranchIcon },
  { label: "Connections", to: "/settings/connections", icon: Link2Icon },
  { label: "Health", to: "/settings/health", icon: ActivityIcon },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
];

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const handleSectionClick = useCallback(
    (to: SettingsSectionPath) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({ to, replace: true });
    },
    [isMobile, navigate, setOpenMobile],
  );
  const handleBackClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, isMobile, navigate, setOpenMobile]);

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {SETTINGS_NAV_ITEMS.map((item) => (
              <SettingsNavRow
                key={item.to}
                item={item}
                isActive={pathname === item.to}
                onSelect={() => handleSectionClick(item.to)}
              />
            ))}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              className="gap-2 px-2 py-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={handleBackClick}
            >
              <ArrowLeftIcon className="size-4" />
              <span>Back</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </>
  );
}

function SettingsNavRow({
  item,
  isActive,
  onSelect,
}: {
  readonly item: SettingsNavItem;
  readonly isActive: boolean;
  readonly onSelect: () => void;
}) {
  if (item.to === "/settings/health") {
    return <HealthNavRow item={item} isActive={isActive} onSelect={onSelect} />;
  }
  return <StandardNavRow item={item} isActive={isActive} onSelect={onSelect} />;
}

function StandardNavRow({
  item,
  isActive,
  onSelect,
}: {
  readonly item: SettingsNavItem;
  readonly isActive: boolean;
  readonly onSelect: () => void;
}) {
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        isActive={isActive}
        className={
          isActive
            ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
            : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
        }
        onClick={onSelect}
      >
        <Icon
          className={
            isActive
              ? "size-4 shrink-0 text-foreground"
              : "size-4 shrink-0 text-muted-foreground/60"
          }
        />
        <span className="truncate">{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function HealthNavRow({
  item,
  isActive,
  onSelect,
}: {
  readonly item: SettingsNavItem;
  readonly isActive: boolean;
  readonly onSelect: () => void;
}) {
  const health = useHostHealth();
  const button = (
    <SidebarMenuButton
      size="sm"
      isActive={isActive}
      className={
        isActive
          ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
          : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
      }
      onClick={onSelect}
    >
      <span className="inline-flex size-4 items-center justify-center">
        <HealthDot status={health.status} />
      </span>
      <span className="truncate">{item.label}</span>
    </SidebarMenuButton>
  );

  return (
    <SidebarMenuItem>
      <Tooltip>
        <TooltipTrigger render={(props) => <div {...props}>{button}</div>} />
        <TooltipPopup side="right" align="center" className="max-w-sm p-3 text-xs">
          <HealthTooltipContent
            snapshot={health.data}
            status={health.status}
            error={health.error}
          />
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
