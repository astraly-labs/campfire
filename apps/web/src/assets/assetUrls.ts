import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";

export { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";

export type AssetUrlState =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure" }
  | { readonly _tag: "Success"; readonly url: string; readonly sourcePath?: string };

// The Codex directive can arrive just before the generated file is visible on disk.
const CODEX_VISUALIZATION_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export function useAssetUrlState(
  environmentId: EnvironmentId,
  resource: AssetResource,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const resourceKey = JSON.stringify([environmentId, resource]);
  const assetQuery = assetEnvironment.createUrl({
    environmentId,
    input: { resource },
  });
  const result = useAtomValue(assetQuery);
  const refresh = useAtomRefresh(assetQuery);
  const [retryAttempt, setRetryAttempt] = useState(0);
  const isCodexVisualization = resource._tag === "codex-visualization";

  useEffect(() => {
    setRetryAttempt(0);
  }, [resourceKey]);

  useEffect(() => {
    if (result._tag === "Success") setRetryAttempt(0);
  }, [result._tag]);

  useEffect(() => {
    if (!isCodexVisualization || result._tag !== "Failure" || result.waiting) return;
    const delay = CODEX_VISUALIZATION_RETRY_DELAYS_MS[retryAttempt];
    if (delay === undefined) return;
    const timeout = setTimeout(() => {
      setRetryAttempt((attempt) => attempt + 1);
      refresh();
    }, delay);
    return () => clearTimeout(timeout);
  }, [isCodexVisualization, refresh, result._tag, result.waiting, retryAttempt]);

  if (result._tag === "Failure") {
    if (result.waiting) return { _tag: "Loading" };
    return { _tag: "Failure" };
  }
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return { _tag: "Loading" };
  }
  const url = resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl);
  return url === null
    ? { _tag: "Failure" }
    : {
        _tag: "Success",
        url,
        ...(result.value.sourcePath !== undefined ? { sourcePath: result.value.sourcePath } : {}),
      };
}

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const result = useAssetUrlState(environmentId, resource);
  if (result._tag !== "Success") {
    return null;
  }
  return result.url;
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result)
              ? resolveAssetUrl(preparedConnection.value.httpBaseUrl, result.value.relativeUrl)
              : null,
          ),
    [preparedConnection, resources, results],
  );
}
