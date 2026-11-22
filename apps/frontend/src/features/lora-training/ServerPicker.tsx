// 從主控機器上挑影片：只列出主控設定的匯入資料夾（import_roots）；資料夾可以點進去，影片可以多選，
// 「加入」時逐一複製進主控檔案庫（原檔不動、不移動）。沒有設定資料夾時說明怎麼開啟。
import { ChevronRight, Folder, FolderOpen, Film, LoaderCircle } from "lucide-react";
import { useState } from "react";
import type { FileRef } from "@/api/generated/contracts";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { CHOICE_BASE, CHOICE_IDLE, CHOICE_SELECTED } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { importLocal, useLocalImports } from "./api";

export interface PickedFile {
  file: FileRef;
  name: string;
  size: number;
}

export function ServerPicker({ onPicked, onClose }: { onPicked: (files: PickedFile[]) => void; onClose: () => void }) {
  const [root, setRoot] = useState<number | null>(null);
  const [path, setPath] = useState("");
  const [chosen, setChosen] = useState<Map<string, number>>(() => new Map());
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const roots = useLocalImports(null, "", true);
  const listing = useLocalImports(root, path, root !== null);
  const rootName = roots.data?.roots?.find((r) => r.root === root)?.name ?? "";
  const crumbs = path === "" ? [] : path.split("/");

  const open = (next: string) => {
    setPath(next);
  };
  const toggle = (name: string, size: number) => {
    const key = path === "" ? name : `${path}/${name}`;
    const next = new Map(chosen);
    if (next.has(key)) next.delete(key);
    else next.set(key, size);
    setChosen(next);
  };
  const add = async () => {
    if (root === null) return;
    setError(null);
    const entries = [...chosen.entries()];
    setBusy({ done: 0, total: entries.length });
    const picked: PickedFile[] = [];
    try {
      for (const [key, size] of entries) {
        picked.push({ file: await importLocal(root, key), name: key.split("/").at(-1) ?? key, size });
        setBusy({ done: picked.length, total: entries.length });
      }
      onPicked(picked);
    } catch (cause) {
      setError(cause);
      if (picked.length > 0) onPicked(picked);
    } finally {
      setBusy(null);
    }
  };

  if (roots.isError) return <ErrorCallout error={roots.error} title={t("無法讀取主控上的資料夾")} onRetry={() => void roots.refetch()} retrying={roots.isFetching} />;
  const rootList = roots.data?.roots ?? [];
  return (
    <div className="grid gap-3 rounded-lg border border-line-subtle bg-sunken/40 p-3 animate-rise-in">
      {roots.isPending ? (
        <p role="status" className="flex items-center gap-2 text-data text-fg-secondary">
          <LoaderCircle aria-hidden className="size-4 animate-spin" />
          {t("讀取中…")}
        </p>
      ) : rootList.length === 0 ? (
        <p className="text-data text-fg-secondary">{t("主控沒有設定可挑選的資料夾。在主控設定加上 import_roots（例如放影片的資料夾）後重新啟動主控，這裡就會列出來。")}</p>
      ) : (
        <>
          <nav aria-label={t("目前位置")} className="flex flex-wrap items-center gap-1 text-data">
            {rootList.map((r) => (
              <button
                key={r.root}
                type="button"
                aria-pressed={root === r.root}
                onClick={() => { setRoot(r.root); setPath(""); setChosen(new Map()); }}
                className={cn(CHOICE_BASE, "inline-flex min-h-9 items-center gap-1.5 rounded-md px-2.5", root === r.root ? CHOICE_SELECTED : CHOICE_IDLE)}
              >
                <Folder aria-hidden className="size-4" />
                {r.name}
              </button>
            ))}
            {root !== null && crumbs.length > 0 ? (
              <span className="flex flex-wrap items-center gap-1 text-fg-secondary">
                <ChevronRight aria-hidden className="size-4" />
                <button type="button" className="underline-offset-2 hover:underline" onClick={() => { open(""); }}>{rootName}</button>
                {crumbs.map((part, i) => (
                  <span key={`${String(i)}-${part}`} className="flex items-center gap-1">
                    <ChevronRight aria-hidden className="size-4" />
                    <button type="button" className="underline-offset-2 hover:underline" onClick={() => { open(crumbs.slice(0, i + 1).join("/")); }}>{part}</button>
                  </span>
                ))}
              </span>
            ) : null}
          </nav>
          {root === null ? (
            <p className="text-data text-fg-secondary">{t("先選一個資料夾。")}</p>
          ) : listing.isError ? (
            <ErrorCallout error={listing.error} title={t("無法讀取這個資料夾")} onRetry={() => void listing.refetch()} retrying={listing.isFetching} />
          ) : listing.isPending ? (
            <p role="status" className="text-data text-fg-secondary">{t("讀取中…")}</p>
          ) : (
            <ul className="grid max-h-64 gap-1 overflow-auto" aria-label={t("資料夾內容")}>
              {(listing.data.entries ?? []).length === 0 ? <li className="text-data text-fg-tertiary">{t("這個資料夾沒有影片。")}</li> : null}
              {(listing.data.entries ?? []).map((entry) => {
                const key = path === "" ? entry.name : `${path}/${entry.name}`;
                const folder = entry.kind === "folder";
                const selected = chosen.has(key);
                return (
                  <li key={entry.name}>
                    <button
                      type="button"
                      aria-pressed={folder ? undefined : selected}
                      onClick={() => { if (folder) open(key); else toggle(entry.name, entry.size_bytes ?? 0); }}
                      className={cn(CHOICE_BASE, "flex min-h-10 w-full items-center gap-2 rounded-md px-2.5 text-left text-data", selected ? CHOICE_SELECTED : CHOICE_IDLE)}
                    >
                      {folder ? <FolderOpen aria-hidden className="size-4 text-fg-tertiary" /> : <Film aria-hidden className="size-4 text-brand-cyan" />}
                      <span className="min-w-0 flex-1 truncate" title={entry.name}>{entry.name}</span>
                      {folder ? <ChevronRight aria-hidden className="size-4 text-fg-tertiary" /> : <span className="machine text-caption text-fg-tertiary">{formatBytes(entry.size_bytes ?? 0)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {error !== null ? <ErrorCallout error={error} write title={t("有影片沒能加入")} /> : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="quiet" onClick={onClose} disabled={busy !== null}>{t("收起")}</Button>
        <Button variant="primary" pending={busy !== null} disabled={chosen.size === 0} onClick={() => void add()}>
          {busy !== null ? t("加入中 {done}／{total}", { done: busy.done, total: busy.total }) : t("加入 {count} 支影片", { count: chosen.size })}
        </Button>
      </div>
    </div>
  );
}
