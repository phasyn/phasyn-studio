// Confirmation before "overwrite with this version" or "keep both" after a revision conflict: lists what the server
// changed and will be kept, what this tab will write, every field both changed (the person picks a side for each,
// default the server's), and for keep both the unsaved edits that will be replayed in order.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ConflictPreview } from "./StudioShellContext";
import type { Side } from "./document/threeWayMerge";
import { t } from "@/i18n";

const SHOWN = 40;

function short(value: unknown): string {
  if (value === undefined) return t("（無）");
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

function PathList({ title, paths, empty }: { title: string; paths: readonly string[]; empty: string }) {
  return (
    <section className="grid gap-1">
      <h3 className="text-data font-semibold text-fg">{title}</h3>
      {paths.length === 0 ? (
        <p className="text-data text-fg-secondary">{empty}</p>
      ) : (
        <ul className="grid max-h-40 gap-0.5 overflow-y-auto font-mono text-data text-fg-secondary">
          {paths.slice(0, SHOWN).map((path) => (
            <li key={path} className="truncate" title={path}>
              {path}
            </li>
          ))}
          {paths.length > SHOWN ? <li>{t("…另外 {count} 項", { count: paths.length - SHOWN })}</li> : null}
        </ul>
      )}
    </section>
  );
}

export function ConflictConfirm({
  state,
  onCancel,
  onConfirm,
}: {
  state: { choice: "overwrite" | "rebase"; preview: ConflictPreview } | null;
  onCancel: () => void;
  onConfirm: (choices: ReadonlyMap<string, Side>) => void;
}) {
  const [choices, setChoices] = useState<ReadonlyMap<string, Side>>(() => new Map());
  const preview = state?.preview;
  const overwrite = state?.choice === "overwrite";
  const pick = (path: string, side: Side) => { setChoices((current) => new Map(current).set(path, side)); };
  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) {
          setChoices(new Map());
          onCancel();
        }
      }}
    >
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{overwrite ? t("以這裡的版本覆寫：確認要寫入的內容") : t("保留兩邊：確認要重新套用的變更")}</DialogTitle>
          <DialogDescription>
            {overwrite
              ? t("逐欄合併：只有別處改過的欄位會保留，只有這裡改過的欄位會寫入；兩邊都改過的欄位，請逐項選擇要用哪一邊。")
              : t("這裡還沒保存的變更，會依序重新套用在最新版上；同一個欄位兩邊都改時，以這裡的為準。")}
          </DialogDescription>
        </DialogHeader>
        {preview ? (
          <DialogBody className="grid gap-4">
            {overwrite && preview.conflicts.length > 0 ? (
              <Callout tone="warning" title={t("{count} 個欄位兩邊都改了", { count: preview.conflicts.length })}>
                <ul className="grid gap-2">
                  {preview.conflicts.map((conflict) => {
                    const side = choices.get(conflict.path) ?? "latest";
                    return (
                      <li key={conflict.path} className="grid gap-1">
                        <span className="font-mono text-data text-fg">{conflict.path}</span>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant={side === "latest" ? "primary" : "secondary"} aria-pressed={side === "latest"} onClick={() => { pick(conflict.path, "latest"); }}>
                            {t("用最新版：{value}", { value: short(conflict.latest) })}
                          </Button>
                          <Button size="sm" variant={side === "mine" ? "primary" : "secondary"} aria-pressed={side === "mine"} onClick={() => { pick(conflict.path, "mine"); }}>
                            {t("用這裡的：{value}", { value: short(conflict.mine) })}
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </Callout>
            ) : null}
            {overwrite ? (
              <>
                <PathList title={t("別處改過、會保留（{count}）", { count: preview.latestKept.length })} paths={preview.latestKept} empty={t("沒有")} />
                <PathList title={t("這裡改過、會寫入（{count}）", { count: preview.mineApplied.length })} paths={preview.mineApplied} empty={t("沒有")} />
              </>
            ) : (
              <PathList title={t("會重新套用的變更（{count}）", { count: preview.replayed.length })} paths={preview.replayed} empty={t("沒有未保存的變更")} />
            )}
          </DialogBody>
        ) : null}
        <DialogFooter>
          <Button
            variant="quiet"
            onClick={() => {
              setChoices(new Map());
              onCancel();
            }}
          >
            {t("取消（保留草稿）")}
          </Button>
          <Button
            variant={overwrite ? "danger" : "primary"}
            onClick={() => {
              const chosen = choices;
              setChoices(new Map());
              onConfirm(chosen);
            }}
          >
            {overwrite ? t("確認覆寫") : t("確認重新套用")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
