// Version conflict banner: the project changed elsewhere, autosave is paused and the local changes are still here.
// The user chooses: load the latest (discard), overwrite with this version, or — where the Studio offers it — keep
// both (re-apply the unsaved changes on the latest version). Overwrite and keep both first show what they will do
// (ConflictConfirm): the overwrite merges field by field, so a change saved elsewhere is kept unless the person picks
// this tab's value for a field both sides changed.
import { GitMerge, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorText } from "@/lib/errors";
import { useStudioShell, type ConflictPreview } from "./StudioShellContext";
import type { Side } from "./document/threeWayMerge";
import { ConflictConfirm } from "./ConflictConfirm";
import { t } from "@/i18n";

type Choice = "reload" | "overwrite" | "rebase";

export function ConflictBanner() {
  const { doc, reload, overwrite, rebase, previewConflict, notify } = useStudioShell();
  const [pending, setPending] = useState<Choice | null>(null);
  const [confirm, setConfirm] = useState<{ choice: "overwrite" | "rebase"; preview: ConflictPreview } | null>(null);
  if (doc.status !== "conflict") return null;
  const fail = (choice: Choice, error: unknown) => { notify({ tone: "danger", title: choice === "reload" ? t("重新載入失敗") : choice === "overwrite" ? t("覆寫失敗") : t("合併失敗"), detail: errorText(error) }); };
  const act = async (choice: Choice, choices?: ReadonlyMap<string, Side>) => {
    setPending(choice);
    try {
      await (choice === "reload" ? reload() : choice === "overwrite" ? overwrite(choices) : rebase?.());
    } catch (error) {
      fail(choice, error);
    } finally {
      setPending(null);
    }
  };
  const ask = async (choice: "overwrite" | "rebase") => {
    setPending(choice);
    try {
      setConfirm({ choice, preview: await previewConflict() });
    } catch (error) {
      fail(choice, error);
    } finally {
      setPending(null);
    }
  };
  return (
    <div role="alert" className="mx-1.5 mb-1.5 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-warning/40 bg-warning/10 px-3 py-1.5 text-data text-warning animate-pop-in">
      <TriangleAlert aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {rebase
          ? t("專案已在其他分頁或另一個 Studio 更新（目前 r{value}）。自動儲存已暫停，這裡還有 {pendingCount} 個未保存的變更。", { value: doc.storedRevision ?? "?", pendingCount: doc.pendingCount })
          : t("專案已在其他分頁或另一個 Studio 更新（目前 r{value}）。自動儲存已暫停，你的變更還在這個分頁。", { value: doc.storedRevision ?? "?" })}
      </span>
      {rebase ? (
        <Button
          size="sm"
          variant="secondary"
          icon={<GitMerge aria-hidden />}
          pending={pending === "rebase"}
          disabled={pending !== null}
          onClick={() => void ask("rebase")}
          title={t("以最新版為基礎，重新套用這裡還沒保存的變更（同一個欄位兩邊都改時，以這裡的為準）")}
        >
          {t("保留兩邊")}
        </Button>
      ) : null}
      <Button size="sm" variant="secondary" icon={<RefreshCw aria-hidden />} pending={pending === "reload"} disabled={pending !== null} onClick={() => void act("reload")}>
        {t("載入最新版（捨棄這裡的變更）")}
      </Button>
      <Button size="sm" variant="danger" pending={pending === "overwrite"} disabled={pending !== null} onClick={() => void ask("overwrite")}>
        {t("以這裡的版本覆寫")}
      </Button>
      <ConflictConfirm
        state={confirm}
        onCancel={() => { setConfirm(null); }}
        onConfirm={(choices) => {
          const choice = confirm?.choice;
          setConfirm(null);
          if (choice) void act(choice, choices);
        }}
      />
    </div>
  );
}
