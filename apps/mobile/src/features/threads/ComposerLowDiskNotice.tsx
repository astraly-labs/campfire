import { lowDiskNotice } from "@t3tools/client-runtime/low-disk-notice";
import type { ServerLowDiskVolume } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

/** Above the composer while the server reports a volume low on free space. */
export function ComposerLowDiskNotice({
  volumes,
}: {
  readonly volumes: ReadonlyArray<ServerLowDiskVolume> | undefined;
}) {
  const notice = lowDiskNotice(volumes);
  if (!notice) return null;
  return (
    <View className="px-4 pb-3">
      <View className="flex-row items-start gap-3 rounded-[20px] border-continuous bg-card p-4">
        <SymbolView
          name="exclamationmark.triangle"
          size={16}
          tintColorClassName="accent-warning-foreground"
          type="monochrome"
        />
        <View className="min-w-0 flex-1 gap-1">
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
            {notice.title}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {notice.description}
          </Text>
          <Text selectable className="text-xs text-foreground-muted">
            {notice.paths.join(", ")}
          </Text>
        </View>
      </View>
    </View>
  );
}
