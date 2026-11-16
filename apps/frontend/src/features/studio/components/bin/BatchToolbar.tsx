// The shot list's toolbar: 新增鏡頭, then 批次渲染 — the shots that would really be sent (the ones on the timeline that
// need rendering, or the selected ones), with the estimate folded into the label (「批次渲染 3・約 14 分」; range, record
// count and memory risk in the tooltip, so the list below never moves) — an amber 「2 個被擋下」 that shows the first
// blocked shot (the monitor and the inspector say why), and the DiT lanes. When the button would send more than one shot
// it asks first (BatchRenderDialog: the shots, why each is in the batch, which to leave out, the total time and when it
// would finish), since a running batch can only be cancelled as a whole; one shot goes at once, as 渲染鏡頭 does.
import { ListVideo, Plus, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { useRenderEta } from "../../hooks/useRenderEta";
import { ETA_RISK_DETAIL, ETA_RISK_LABEL, missingEtaReason, planEtaText } from "../../model/eta";
import { useProjectLanes } from "../../model/lanePrefs";
import { engineUnavailable } from "../../model/routes";
import { useStudio } from "../../studioContext";
import { LaneDialog } from "../LaneDialog";
import { BatchRenderDialog } from "./BatchRenderDialog";
import { compactEta, lanesLine, type BatchScope, type BlockedShot } from "./batchScope";

export interface BatchToolbarProps {
  scope: BatchScope;
  renderable: readonly StudioShot[];
  blocked: readonly BlockedShot[];
  /** Place in the film (0-based) of the shots on the timeline (the confirmation lists them by it). */
  positions: ReadonlyMap<string, number>;
  /** Show a blocked shot: it becomes the current shot, so the monitor and the inspector say why it is blocked. */
  onShowBlocked: (shotId: string) => void;
}

/** Why the batch cannot be sent now; null when it can. */
function blockedReason(scope: BatchScope, count: number, blocked: number, outside: string | null): string | null {
  if (outside) return outside;
  if (count > 0) return null;
  if (blocked > 0) return t("沒有可以渲染的鏡頭：{count} 個被擋下", { count: blocked });
  return scope.selection ? t("選取的鏡頭都還沒有 prompt 或正在渲染") : t("時間軸上沒有需要（重新）渲染且已有 prompt 的鏡頭");
}

function BlockedBadge({ blocked, onShow }: { blocked: readonly BlockedShot[]; onShow: (shotId: string) => void }) {
  const first = blocked[0];
  if (!first) return null;
  const reasons = blocked.map(({ shot, reason }) => t("{label}：{detail}", { label: shot.title || t("未命名鏡頭"), detail: reason }));
  return (
    <button
      type="button"
      onClick={() => onShow(first.shot.shot_id)}
      title={[t("按一下查看第一個被擋下的鏡頭"), ...reasons].join("\n")}
      className="pressable inline-flex h-8 shrink-0 items-center rounded-md border border-warning/40 bg-warning/12 px-2 text-caption font-medium whitespace-nowrap text-warning animate-pop-in hover:border-warning/70 hover:bg-warning/18 active:bg-warning/24"
    >
      {t("{count} 個被擋下", { count: blocked.length })}
    </button>
  );
}

export function BatchToolbar({ scope, renderable, blocked, positions, onShowBlocked }: BatchToolbarProps) {
  const { project, engine, addShot, renderShots, busy, runBlockedReason } = useStudio();
  const lanes = useProjectLanes(project.project_id);
  const estimate = useRenderEta(renderable);
  // The confirmation: mounted once per opening (session) and kept while it closes, so its exit animates
  const [confirm, setConfirm] = useState<{ open: boolean; session: number } | null>(null);
  const count = renderable.length;
  const label = scope.selection ? t("渲染選取的 {count} 個", { count }) : t("批次渲染 {value}", { value: count > 0 ? count : "" });
  const fade = useChangeFade<HTMLSpanElement>(label);
  const unavailable = runBlockedReason ?? engineUnavailable(engine) ?? (busy === "export" ? t("正在送出匯出請求") : null);
  const reason = blockedReason(scope, count, blocked.length, unavailable);
  const risk = estimate.risks.worst;
  const details = [
    lanesLine(engine.routes, lanes, count),
    estimate.eta ? planEtaText(estimate.eta) : estimate.pending || !estimate.missing ? t("估算中…") : t("{label}：{detail}", { label: t("尚無預估"), detail: missingEtaReason(estimate.missing) }),
    risk ? t("{label}：{detail}", { label: ETA_RISK_LABEL[risk], detail: ETA_RISK_DETAIL[risk] }) : null,
    scope.skipped > 0 ? t("略過 {count} 個還沒有 prompt 或正在渲染的鏡頭", { count: scope.skipped }) : null,
  ];
  const send = () => {
    if (count > 1) setConfirm((current) => ({ open: true, session: (current?.session ?? 0) + 1 }));
    else void renderShots(renderable.map((shot) => shot.shot_id));
  };
  return (
    <div className="grid shrink-0 gap-1.5 border-b border-line-subtle p-2">
      <Button size="sm" variant="secondary" icon={<Plus aria-hidden />} onClick={() => addShot()} title={t("新增鏡頭")} className="w-full min-w-0">
        <span className="truncate">{t("新增鏡頭")}</span>
      </Button>
      <div className="flex min-w-0 items-center gap-1.5">
        <ActionButton
          size="sm"
          variant="secondary"
          icon={risk ? <TriangleAlert aria-hidden className={risk === "oom" ? "text-danger" : "text-warning"} /> : <ListVideo aria-hidden />}
          pending={busy === "render"}
          disabledReason={reason}
          aria-haspopup={count > 1 ? "dialog" : undefined}
          onClick={send}
          title={details.filter(Boolean).join("\n")}
          className="min-w-0 flex-1 justify-start px-2.5"
        >
          <span ref={fade} className="min-w-0 truncate">
            {label}
          </span>
          {estimate.eta && reason === null ? <span className="min-w-0 shrink-[100] truncate font-normal text-fg-secondary">{t("・{label}", { label: compactEta(estimate.eta.totalSeconds) })}</span> : null}
        </ActionButton>
        <BlockedBadge blocked={blocked} onShow={onShowBlocked} />
        <LaneDialog />
      </div>
      {confirm ? (
        <BatchRenderDialog
          key={confirm.session}
          open={confirm.open}
          scope={scope}
          blocked={blocked}
          positions={positions}
          unavailable={unavailable}
          onClose={() => setConfirm((current) => (current ? { ...current, open: false } : current))}
        />
      ) : null}
    </div>
  );
}
