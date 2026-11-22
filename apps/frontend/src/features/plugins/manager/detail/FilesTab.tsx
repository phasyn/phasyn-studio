// 詳情「檔案與版本」：版本、修訂與 digest，以及包內的檔案（plugin.json 與 integrity.files 列出的每個檔案）。點一個檔案在
// 下方預覽：文字檔以純文字顯示（從不當成 HTML 或 Markdown 繪製）、驗過檔頭的點陣圖顯示圖片；程式碼入口 main.js 這個版本
// 不提供內容。安裝預覽中的包還沒有保存在主控，所以只列出檔案。
import { FileCode, FileImage, FileJson, FileText } from "lucide-react";
import { useState } from "react";
import type { StudioPlugin, StudioPluginDetail, StudioPluginFile } from "@/api/generated/contracts";
import { PLUGIN_FILE_PREVIEW_BYTES, pluginFileUrl, usePluginFileText } from "@/api/plugins";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { IdText } from "@/components/common/values";
import { Skeleton } from "@/components/ui/skeleton";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { useRevealRef } from "../../parts/motion";

const MANIFEST = "plugin.json";
const MAIN = "main.js";
const TEXT_FILE = /(\.(md|txt|json|cube|js)|^LICENSE)$/i;
const COLUMNS = "grid-cols-[minmax(0,1fr)_5.5rem]";

export interface DetailState {
  pending: boolean;
  error: unknown;
  retrying: boolean;
  retry: () => void;
}

function FileIcon({ path, mediaType, className }: { path: string; mediaType: string; className: string }) {
  if (mediaType.startsWith("image/")) return <FileImage aria-hidden className={className} />;
  if (path.endsWith(".json")) return <FileJson aria-hidden className={className} />;
  return path.endsWith(".js") ? <FileCode aria-hidden className={className} /> : <FileText aria-hidden className={className} />;
}

function FileRow({ index, path, size, mediaType, selected, onSelect }: { index: number; path: string; size: number | null; mediaType: string; selected: boolean; onSelect: () => void }) {
  const enter = useRevealRef(index);
  return (
    <li ref={enter}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        title={path}
        className={cn(
          "grid min-h-9 w-full items-center gap-3 rounded-md px-2 text-left transition-colors duration-(--duration-fast)",
          COLUMNS,
          selected ? "bg-brand-gradient-soft text-fg" : "text-fg-secondary hover:bg-raised/70 hover:text-fg",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <FileIcon path={path} mediaType={mediaType} className={cn("size-4 shrink-0", selected ? "text-brand-cyan" : "text-fg-tertiary")} />
          <span className="machine truncate text-data">{path}</span>
        </span>
        <span className="machine text-right text-caption text-fg-tertiary">{size === null ? "" : formatBytes(size)}</span>
      </button>
    </li>
  );
}

function TextPreview({ text }: { text: string }) {
  return <pre className="machine m-0 min-h-0 flex-1 overflow-auto p-3 text-caption leading-5 whitespace-pre-wrap text-fg-secondary">{text}</pre>;
}

function NoPreview({ children }: { children: string }) {
  return <p className="grid min-h-0 flex-1 place-items-center p-4 text-center text-data text-fg-tertiary">{children}</p>;
}

function RemoteText({ pluginId, digest, path }: { pluginId: string; digest: string; path: string }) {
  const query = usePluginFileText(pluginId, digest, path);
  if (query.isPending) {
    return (
      <div role="status" aria-label={t("讀取檔案…")} className="grid flex-1 content-start gap-2 p-3">
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <ErrorCallout error={query.error} title={t("讀不到這個檔案")} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      </div>
    );
  }
  return <TextPreview text={query.data} />;
}

function Preview({ plugin, detail, file, preview }: { plugin: StudioPlugin; detail: StudioPluginDetail; file: StudioPluginFile | null; preview: boolean }) {
  if (file === null) return <TextPreview text={`${JSON.stringify(detail.manifest, null, 2)}\n`} />;
  if (file.path === MAIN) return <NoPreview>{t("這個版本不提供插件程式碼的內容")}</NoPreview>;
  if (preview) return <NoPreview>{t("安裝之後才能預覽檔案內容")}</NoPreview>;
  if (file.media_type.startsWith("image/")) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center overflow-hidden bg-stage p-3">
        <img src={pluginFileUrl(plugin.plugin_id, file.path)} alt={file.path} draggable={false} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  if (!TEXT_FILE.test(file.path)) return <NoPreview>{t("這種檔案沒有預覽")}</NoPreview>;
  if (file.size_bytes > PLUGIN_FILE_PREVIEW_BYTES) return <NoPreview>{t("檔案超過 {limit}，不預覽", { limit: formatBytes(PLUGIN_FILE_PREVIEW_BYTES) })}</NoPreview>;
  return <RemoteText key={file.path} pluginId={plugin.plugin_id} digest={plugin.digest ?? ""} path={file.path} />;
}

export function FilesTab({ plugin, detail, state, preview }: { plugin: StudioPlugin; detail: StudioPluginDetail | null; state: DetailState | null; preview: boolean }) {
  const [picked, setPicked] = useState<string>(MANIFEST);
  if (!detail) {
    if (state?.error != null) return <ErrorCallout error={state.error} title={t("讀不到這個插件的內容")} onRetry={state.retry} retrying={state.retrying} />;
    return (
      <div role="status" aria-label={t("讀取插件內容…")} className="grid content-start gap-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }
  const files = detail.files;
  const file = files.find((item) => item.path === picked) ?? null;
  const hasManifest = detail.manifest !== null;
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <dl className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 text-data">
        <div className="flex items-baseline gap-2">
          <dt className="text-fg-tertiary">{t("版本")}</dt>
          <dd className="machine m-0 text-fg">{plugin.version ?? "—"}</dd>
        </div>
        {plugin.source === "installed" ? (
          <div className="flex items-baseline gap-2">
            <dt className="text-fg-tertiary" title={t("每次更新、停用或啟用加一")}>
              {t("修訂")}
            </dt>
            <dd className="machine m-0 text-fg-secondary">{plugin.revision}</dd>
          </div>
        ) : null}
        {(plugin.digest != null && plugin.digest !== "") ? (
          <div className="flex min-w-0 items-center gap-2">
            <dt className="text-fg-tertiary">digest</dt>
            <dd className="m-0 min-w-0">
              <IdText value={plugin.digest} length={12} />
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(7rem,2fr)_minmax(8rem,3fr)] overflow-hidden rounded-lg border border-line-subtle bg-canvas/60">
        <ul aria-label={t("包內的檔案")} className="grid min-h-0 content-start gap-0.5 overflow-y-auto p-1.5">
          {hasManifest ? <FileRow index={0} path={MANIFEST} size={null} mediaType="application/json" selected={file === null} onSelect={() => { setPicked(MANIFEST); }} /> : null}
          {files.map((item, index) => (
            <FileRow
              key={item.path}
              index={index + 1}
              path={item.path}
              size={item.size_bytes}
              mediaType={item.media_type}
              selected={file?.path === item.path}
              onSelect={() => { setPicked(item.path); }}
            />
          ))}
        </ul>
        <div className="flex min-h-0 flex-col border-t border-line-subtle bg-sunken/60">
          {hasManifest || file ? <Preview plugin={plugin} detail={detail} file={file} preview={preview} /> : <NoPreview>{t("這個包的內容讀不到")}</NoPreview>}
        </div>
      </div>
    </div>
  );
}
