// 刪除研究：先選模式（保留圖片／完整移除），以試算（dry_run）列出影響範圍，確認後送出一次刪除請求並照實列出結果。
// 有執行中的 run 時不能刪；刪除不自動重試；連線中斷時顯示遠端結果未知，請使用者重新讀取列表確認。
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CircleCheck, FileText, FileX2, HardDrive, Image as ImageIcon, Info, LoaderCircle, Lock, Trash2, TriangleAlert } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { pageFocusTarget } from "@/components/common/routeFocus";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { returnFocusOr } from "@/components/ui/focusReturn";
import { cn } from "@/lib/cn";
import { toErrorInfo } from "@/lib/errors";
import { deleteStudy, fetchDeletePlan, studyKeys } from "../api";
import { normalizeDeletionPlan } from "../model/normalize";
import { DELETE_MODES, deleteBlockReason, deleteModeLabel, deleteResultLines, deleteScopeLines, type ScopeIcon, type ScopeLine } from "../model/deletePlan";
import type { DeleteMode, PromptStudyDeletionPlan } from "../types";
import { t } from "@/i18n";

const ICONS: Record<ScopeIcon, ReactNode> = {
  document: <FileText aria-hidden />,
  files: <HardDrive aria-hidden />,
  keep: <ImageIcon aria-hidden />,
  source: <ImageIcon aria-hidden />,
  blocked: <Ban aria-hidden />,
  note: <Info aria-hidden />,
  irreversible: <TriangleAlert aria-hidden />,
};

const TONE_CLASS: Record<ScopeLine["tone"], string> = {
  neutral: "text-fg-secondary",
  warning: "text-warning",
  danger: "text-danger",
  success: "text-success",
};

function ScopeList({ lines, label }: { lines: readonly ScopeLine[]; label: string }) {
  return (
    <ul className="grid gap-2 text-data" aria-label={label}>
      {lines.map((line, index) => (
        <li key={`${line.icon}-${index}`} className={cn("flex items-start gap-2 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0", TONE_CLASS[line.tone])}>
          {ICONS[line.icon]}
          <span>{line.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function DeleteStudyDialog({
  study,
  open,
  onOpenChange,
  onDeleted,
}: {
  study: { study_id: string; title: string; revision: number } | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (plan: PromptStudyDeletionPlan) => void;
}) {
  const client = useQueryClient();
  const id = useId();
  const [mode, setMode] = useState<DeleteMode>("keep_images");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<PromptStudyDeletionPlan | null>(null);
  const [error, setError] = useState<unknown>(null);
  /** 開啟對話框的按鈕（研究頁或列表檢視器的「刪除…」）：刪除成功後它會跟著研究頁或選取一起消失。 */
  const opener = useRef<HTMLElement | null>(null);
  // 研究的名稱在刪除後仍要顯示（列表重新讀取後 study 會變成空的）：記下最後一次看到的名稱
  const [shownTitle, setShownTitle] = useState(study?.title ?? "");
  if (study && study.title !== shownTitle) setShownTitle(study.title);
  const studyId = study?.study_id ?? "";
  const plan = useQuery({
    queryKey: studyKeys.deletePlan(studyId, mode),
    queryFn: ({ signal }) => fetchDeletePlan(studyId, mode, signal),
    enabled: open && Boolean(study) && result === null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const blocked = plan.data ? deleteBlockReason(plan.data) : null;
  // 刪到一半停下來時，主控在錯誤的 details 附上已處理的項目（status=deleted）；照實列出
  const partial = error ? normalizeDeletionPlan(toErrorInfo(error).details, studyId, mode) : null;

  const close = (next: boolean) => {
    if (pending) return;
    if (!next && result?.deleted) onDeleted(result);
    onOpenChange(next);
  };

  const confirm = async () => {
    if (!study || pending || !plan.data || blocked) return;
    setPending(true);
    setError(null);
    try {
      const outcome = await deleteStudy(study.study_id, mode, study.revision);
      setResult(outcome);
      void client.invalidateQueries({ queryKey: studyKeys.list() });
      if (outcome.deleted) client.removeQueries({ queryKey: studyKeys.study(study.study_id) });
    } catch (cause) {
      setError(cause);
      void plan.refetch();
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        onOpenAutoFocus={() => {
          const active = document.activeElement;
          opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
        }}
        // 開啟它的按鈕還在（取消、刪除失敗）就照常回到它；刪除後它不在了，焦點改到頁面標題，不掉到 body
        onCloseAutoFocus={(event) => {
          // 關閉動畫結束後才清掉結果：在關閉時清會讓淡出中的對話框退回刪除前的畫面
          setResult(null);
          setError(null);
          setMode("keep_images");
          returnFocusOr(event, opener.current, pageFocusTarget());
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("刪除研究「{value}」？", { value: shownTitle || t("未命名研究") })}</DialogTitle>
          <DialogDescription>{t("先選擇刪除方式，下方列出實際影響範圍；確認後送出一次請求，無法復原。只想先收起來請改用「封存」。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          {result ? (
            <ScopeList lines={deleteResultLines(result)} label={t("刪除結果")} />
          ) : (
            <>
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-data font-medium text-fg-secondary">{t("刪除方式")}</legend>
                {DELETE_MODES.map((item) => (
                  <label
                    key={item.mode}
                    htmlFor={`${id}-${item.mode}`}
                    className="pressable flex cursor-pointer items-start gap-3 rounded-lg border border-line-subtle p-3 hover:border-line-control has-checked:border-brand-blue/55 has-checked:bg-brand-gradient-soft has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus"
                  >
                    <input
                      id={`${id}-${item.mode}`}
                      type="radio"
                      name={`${id}-mode`}
                      className="mt-1 size-4 accent-action"
                      checked={mode === item.mode}
                      disabled={pending}
                      onChange={() => setMode(item.mode)}
                    />
                    <span className="grid gap-0.5">
                      <span className="text-data font-medium text-fg">{item.label}</span>
                      <span className="text-caption text-fg-tertiary">{item.description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <section className="grid gap-2" aria-labelledby={`${id}-scope`}>
                <h3 id={`${id}-scope`} className="text-data font-semibold text-fg">
                  {t("影響範圍（{mode}）", { mode: deleteModeLabel(mode) })}
                </h3>
                {plan.isPending ? (
                  <p role="status" className="flex items-center gap-2 text-data text-fg-secondary">
                    <LoaderCircle aria-hidden className="size-4 text-brand-cyan animate-spin" />
                    {t("正在試算會刪除哪些內容…")}
                  </p>
                ) : plan.isError ? (
                  <ErrorCallout error={plan.error} title={t("無法試算刪除範圍（沒有刪除任何東西）")} onRetry={() => void plan.refetch()} retrying={plan.isFetching} />
                ) : plan.data ? (
                  <ScopeList lines={deleteScopeLines(plan.data, shownTitle)} label={t("刪除範圍")} />
                ) : null}
              </section>
            </>
          )}
          {error ? <ErrorCallout error={error} write title={t("刪除沒有完成（不會自動重試）")} /> : null}
          {partial && partial.runs.some((row) => row.status !== "planned") ? <ScopeList lines={deleteResultLines(partial)} label={t("停止前已處理的項目")} /> : null}
          {result && !result.deleted ? (
            <p className="flex items-start gap-2 text-caption text-fg-secondary">
              <FileX2 aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              {t("伺服器回報研究沒有刪除；可以重新試算後再決定。")}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {result ? (
            <Button variant="secondary" icon={result.deleted ? <CircleCheck aria-hidden /> : undefined} onClick={() => close(false)}>
              {t("關閉")}
            </Button>
          ) : (
            <>
              <Button variant="quiet" onClick={() => close(false)} disabled={pending}>
                {t("取消")}
              </Button>
              <Button
                variant="danger-confirm"
                icon={blocked ? <Lock aria-hidden /> : <Trash2 aria-hidden />}
                pending={pending}
                disabled={!plan.data || Boolean(blocked) || pending}
                title={blocked ?? (!plan.data ? t("試算完成後才能刪除") : undefined)}
                onClick={() => void confirm()}
              >
                {mode === "all" ? t("完整移除") : t("刪除研究（保留圖片）")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
