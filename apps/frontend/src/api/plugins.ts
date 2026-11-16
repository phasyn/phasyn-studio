// Studio plugin packages (x-phasyn-extension): the registry both rule evaluators
// read, one package, installing from a .phasynplugin file (dry run, then the real install), switching a package off or
// on for the whole installation, the removal preview and removal, export, and reloading a development package.
// A package is uploaded as raw bytes (application/octet-stream). Writes are sent once and never retried; after each of
// them the registry is read again.
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  StudioPluginDetail,
  StudioPluginId,
  StudioPluginInstallResult,
  StudioPluginList,
  StudioPluginPatch,
  StudioPluginRemoval,
  StudioPluginRemovalPreview,
} from "./generated/contracts";
import { ApiError, apiFetch, apiJson } from "./http";
import { t } from "@/i18n";

export const pluginKeys = {
  /** Prefix of every plugin query (invalidate it after a write). */
  all: () => ["studio", "plugins"] as const,
  registry: () => ["studio", "plugins", "registry"] as const,
  /** stamp: what identifies the package's content and state (digest and revision), so a changed package is read again. */
  detail: (pluginId: StudioPluginId, stamp: string) => ["studio", "plugins", "detail", pluginId, stamp] as const,
  removalPreview: (pluginId: StudioPluginId) => ["studio", "plugins", "removal-preview", pluginId] as const,
  file: (pluginId: StudioPluginId, digest: string, path: string) => ["studio", "plugins", "file", pluginId, digest, path] as const,
};

const ROOT = "/api/studio/plugins";
const pluginPath = (pluginId: StudioPluginId) => `${ROOT}/${encodeURIComponent(pluginId)}`;

/** File extension of a plugin package. */
export const PLUGIN_PACKAGE_EXTENSION = ".phasynplugin";
/** Text files are previewed as plain text up to this size; larger ones are only listed. */
export const PLUGIN_FILE_PREVIEW_BYTES = 256 * 1024;

export function fetchPluginRegistry(signal?: AbortSignal): Promise<StudioPluginList> {
  return apiJson<StudioPluginList>(ROOT, { signal });
}

/**
 * The registry query. It is read once and then kept: writes from this tab invalidate it, and it is read again when
 * the window gets focus once it is 30 s old (another tab or an agent may have installed or switched off a package).
 */
export const pluginRegistryQuery = queryOptions({
  queryKey: pluginKeys.registry(),
  queryFn: ({ signal }) => fetchPluginRegistry(signal),
  staleTime: 30_000,
  refetchOnWindowFocus: true,
});

export function usePluginRegistryQuery() {
  return useQuery(pluginRegistryQuery);
}

export function fetchPlugin(pluginId: StudioPluginId, signal?: AbortSignal): Promise<StudioPluginDetail> {
  return apiJson<StudioPluginDetail>(pluginPath(pluginId), { signal });
}

/** One package's manifest, files and consent record; `stamp` is its digest and revision as the registry lists them. */
export function usePluginDetail(pluginId: StudioPluginId | null, stamp: string) {
  return useQuery({
    queryKey: pluginKeys.detail(pluginId ?? "", stamp),
    queryFn: ({ signal }) => fetchPlugin(pluginId ?? "", signal),
    enabled: pluginId !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export interface InstallOptions {
  /** Validate only and report what an install would do; nothing is installed. */
  dryRun?: boolean;
  /** Replace the installed package of the same id. */
  replace?: boolean;
  /** The digest the dry run reported: the Controller refuses another content. */
  digest?: string | null;
  signal?: AbortSignal;
}

/** POST /api/studio/plugins with the package's bytes: 200 for a dry run, 201 once installed. */
export function installPlugin(file: Blob, options: InstallOptions = {}): Promise<StudioPluginInstallResult> {
  return apiJson<StudioPluginInstallResult>(ROOT, {
    method: "POST",
    query: { dry_run: options.dryRun ? true : null, replace: options.replace ? true : null, digest: options.digest ?? null },
    body: file,
    headers: { "Content-Type": "application/octet-stream" },
    signal: options.signal,
  });
}

/** A file larger than the Controller's limit is not uploaded at all (the Controller would answer 413). */
export function packageTooLarge(file: Blob, maxBytes: number): ApiError | null {
  if (file.size <= maxBytes) return null;
  return new ApiError(413, { code: "PAYLOAD_TOO_LARGE", message: t("插件包超過主控的大小上限，沒有上傳"), details: { size: file.size, limit: maxBytes } }, "PAYLOAD_TOO_LARGE", "POST");
}

export function patchPlugin(pluginId: StudioPluginId, body: StudioPluginPatch): Promise<StudioPluginDetail> {
  return apiJson<StudioPluginDetail>(pluginPath(pluginId), { method: "PATCH", json: body });
}

export function fetchRemovalPreview(pluginId: StudioPluginId, signal?: AbortSignal): Promise<StudioPluginRemovalPreview> {
  return apiJson<StudioPluginRemovalPreview>(`${pluginPath(pluginId)}/removal-preview`, { signal });
}

/** Which projects still use the package (read again every time the removal dialog opens). */
export function useRemovalPreview(pluginId: StudioPluginId | null) {
  return useQuery({
    queryKey: pluginKeys.removalPreview(pluginId ?? ""),
    queryFn: ({ signal }) => fetchRemovalPreview(pluginId ?? "", signal),
    enabled: pluginId !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** DELETE with the digest the user saw; project documents are never edited. */
export function removePlugin(pluginId: StudioPluginId, digest: string): Promise<StudioPluginRemoval> {
  return apiJson<StudioPluginRemoval>(pluginPath(pluginId), { method: "DELETE", query: { digest } });
}

export function reloadPlugin(pluginId: StudioPluginId): Promise<StudioPluginDetail> {
  return apiJson<StudioPluginDetail>(`${pluginPath(pluginId)}/reload`, { method: "POST" });
}

/** URL of one file of a package (served as data: octet-stream, or an image type for a checked bitmap). */
export function pluginFileUrl(pluginId: StudioPluginId, path: string): string {
  return `${pluginPath(pluginId)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** A text file of a package (README, LICENSE, JSON) as plain text. */
export async function fetchPluginFileText(pluginId: StudioPluginId, path: string, signal?: AbortSignal): Promise<string> {
  const response = await apiFetch(pluginFileUrl(pluginId, path), { signal, headers: { Accept: "application/octet-stream" } });
  return new TextDecoder("utf-8", { fatal: false }).decode(await response.arrayBuffer());
}

/** digest: the package's digest, so a replaced package never shows the old file. */
export function usePluginFileText(pluginId: StudioPluginId, digest: string, path: string | null) {
  return useQuery({
    queryKey: pluginKeys.file(pluginId, digest, path ?? ""),
    queryFn: ({ signal }) => fetchPluginFileText(pluginId, path ?? "", signal),
    enabled: path !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/** The download name from Content-Disposition (filename*= first, then filename=); null when there is none. */
export function dispositionFileName(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (extended?.[1]) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // fall through to the plain parameter
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(header);
  const name = (plain?.[1] ?? plain?.[2] ?? "").trim();
  return name === "" ? null : name;
}

export interface ExportedPackage {
  fileName: string;
  blob: Blob;
}

/** The package re-packed by the Controller from its validated content. */
export async function exportPlugin(pluginId: StudioPluginId, fallbackName: string, signal?: AbortSignal): Promise<ExportedPackage> {
  const response = await apiFetch(`${pluginPath(pluginId)}/package`, { signal, headers: { Accept: "application/octet-stream" } });
  const named = dispositionFileName(response.headers.get("Content-Disposition"));
  // The name becomes a local file name: keep only its last path segment
  const fileName = (named ?? fallbackName).split(/[\\/]/).pop() || fallbackName;
  return { fileName, blob: await response.blob() };
}

/** After a write: every plugin query is read again (the registry, details, removal previews). */
export function useInvalidatePlugins() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: pluginKeys.all() });
}
