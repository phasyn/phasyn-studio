// 「渲染鏡頭」：在 Studio 工具列右側、「渲染引擎」左邊的大按鈕（一定顯示文字），渲染選取的鏡頭。按鈕也說出代價與鏡頭的
// 狀態：路線的元件要在使用時載入時第二行是「使用時載入（約 N 秒）」，否則有成本紀錄時第二行是預估時間（「約 4:20」；區間、紀錄次數與記憶體風險在提示裡，連同 Ctrl+Enter），鏡頭需要更新
// 或沒有完成時圖示左邊、垂直置中有一個狀態點（琥珀＝需要更新或中斷、紅＝失敗；在按鈕左側留白裡，不壓到文字），那句話在
// 提示與無障礙描述裡。
// 不能渲染時按鈕保持可聚焦並以提示說明原因。元件沒準備好時不另外放按鈕：旁邊的「渲染引擎」轉成琥珀色、說明原因，按下開到
// 要啟動的元件（chrome/EngineButton.tsx）；插件規則、prompt、參考素材或鏡頭設定的問題則旁邊多一個帶去修的按鈕，切到「鏡頭」
// 工作區屬性面板的對應分頁（逐項原因在它的提示裡）。第一次按下時向瀏覽器要一次通知
// 權限（渲染結束時通知；chrome/renderAlerts.ts）。
import { Clapperboard, Images, PenLine, Puzzle, SlidersHorizontal, TriangleAlert, type LucideIcon } from "lucide-react";
import { memo, useId, useMemo, type Ref } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import type { StudioShot } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { cn } from "@/lib/cn";
import { useRenderEta } from "../hooks/useRenderEta";
import type { PlanEtaState } from "../hooks/usePlanEta";
import { renderDisabledReason, useRenderBlock } from "../hooks/useRenderBlock";
import { ETA_RISK_DETAIL, ETA_RISK_LABEL, ETA_UNAVAILABLE, formatEtaClock, missingEtaReason, planEtaText } from "../model/eta";
import { activeTake, changedSinceTake, shotStatus, type ShotStatus } from "../model/project";
import { findRoute } from "../model/routes";
import type { RenderProblem, RenderProblemKind } from "../model/renderPlan";
import { useRenderActivity } from "../renderActivityContext";
import { useStudio } from "../studioContext";
import { askRenderAlerts } from "./chrome/renderAlerts";
import { onUseText, useOnUseLoad } from "./generation/loadOnUse";
import { revealInspectorTab, type InspectorTab } from "./inspector/inspectorTab";
import { t, tServer } from "@/i18n";
import { formatList } from "@/i18n/format";

/**
 * 鏡頭狀態的一句話（提示與無障礙描述）。live＝這個專案的渲染正在跑：進度就在旁邊的渲染膠囊與狀態列，不再指向「渲染」工作區。
 */
function statusText(shot: StudioShot, project: Parameters<typeof shotStatus>[1], live: boolean): string {
  const status = shotStatus(shot, project);
  const active = activeTake(shot);
  const latest = shot.takes.at(-1);
  const error = latest?.error ? `${latest.error.code} ${tServer(latest.error.message)}` : null;
  if (status === "rendering") return live ? t("渲染中") : t("渲染中；進度在「渲染」工作區。");
  if (status === "ready" && active?.seed === null) return t("{label}（使用中）", { label: t("take {number}", { number: shot.takes.indexOf(active) + 1 }) });
  if (status === "ready" && active && active.seed !== null) return t("使用 take {active}（seed {seed}）。", { active: shot.takes.indexOf(active) + 1, seed: active.seed });
  if (status === "stale" && active) return t("使用中的 take 是舊設定（已變更：{changedSinceTake}）；重新渲染才會反映。", { changedSinceTake: formatList(changedSinceTake(active, shot, project)) });
  if (status === "failed" && (error != null && error !== "")) return t("最近一次失敗：{error}", { error });
  if (status === "cancelled") return (error != null && error !== "") ? t("最近一次已取消：{error}", { error }) : t("最近一次已取消。");
  if (status === "interrupted") return (error != null && error !== "") ? t("最近一次中斷：{error}", { error }) : t("最近一次中斷");
  return t("還沒渲染過。");
}

/** The estimate in the tooltip: its band and the records behind it, or why there is none. */
function etaHead({ eta, pending, missing }: PlanEtaState): string | null {
  if (eta) return planEtaText(eta);
  if (pending) return t("估算中…");
  if (missing === "none") return ETA_UNAVAILABLE;
  return missing ? t("尚無預估（{reason}）", { reason: missingEtaReason(missing) }) : null;
}

/** The estimate's lines for the tooltip and the description: the estimate, then a memory risk. */
function etaLines(state: PlanEtaState): string[] {
  const { worst } = state.risks;
  const risk = worst ? t("{label}：{detail}", { label: ETA_RISK_LABEL[worst], detail: ETA_RISK_DETAIL[worst] }) : null;
  return [etaHead(state), risk].filter((line): line is string => line !== null);
}

/** The shot's state as a dot on the icon (only when it asks for attention); the colours are the shot list's. */
const STATUS_DOT: Partial<Record<ShotStatus, string>> = {
  stale: "bg-warning",
  interrupted: "bg-warning",
  failed: "bg-danger",
  cancelled: "bg-fg-secondary",
  rendering: "bg-info",
};

function RenderIcon({ status }: { status: ShotStatus }) {
  const dot = STATUS_DOT[status];
  return (
    <span aria-hidden className="relative inline-grid shrink-0">
      <Clapperboard />
      {/* left of the icon, vertically centred: in the button's left padding, clear of the label */}
      {(dot != null && dot !== "") ? <span key={status} className={cn("absolute top-1/2 -left-3 size-2 -translate-y-1/2 rounded-full ring-2 ring-black/35 animate-pop-in", dot)} /> : null}
    </span>
  );
}

const BUTTON_CLASS = "h-10 shrink-0 px-5 text-body";

/** 工具列上的「渲染鏡頭」（「渲染引擎」左邊）：渲染選取的鏡頭；大按鈕、一定有文字。buttonRef：按鈕本身（工具列把焦點交回這裡）。 */
/** compact: the toolbar is out of room (its last fit level); the fix button then keeps only its icon (its label stays in aria-label and the tooltip). */
export function RenderShotControl({ buttonRef, compact = false }: { buttonRef?: Ref<HTMLButtonElement>; compact?: boolean }) {
  const { project, selectedShotId } = useStudio();
  // Whether this project's render runs is all this control needs from the ticking activity
  const live = useRenderActivity() !== null;
  const shot = project.shots.find((item) => item.shot_id === selectedShotId) ?? null;
  if (!shot) {
    return (
      <ActionButton
        ref={buttonRef}
        size="md"
        variant="primary"
        icon={<Clapperboard aria-hidden />}
        disabledReason={t("先在左側選一個鏡頭")}
        className={BUTTON_CLASS}
      >
        {t("渲染鏡頭")}
      </ActionButton>
    );
  }
  return <RenderShotButton shot={shot} live={live} {...(buttonRef === undefined ? {} : { buttonRef })} compact={compact} />;
}

interface RenderShotButtonProps {
  shot: StudioShot;
  /** This project's render runs (the status sentence then points to the capsule beside the button). */
  live: boolean;
  buttonRef?: Ref<HTMLButtonElement>;
  /** The fix button keeps only its icon. */
  compact: boolean;
}

/** Problems the toolbar's 「渲染引擎」 button speaks for (it turns amber and opens the sheet on them): no fix button here. */
type FixKind = Exclude<RenderProblemKind, "engine">;

/** Where each other kind of problem is fixed: a tab of the generate workspace's inspector. */
const FIX: Readonly<Record<FixKind, { icon: LucideIcon; label: () => string; tab: InspectorTab }>> = {
  plugins: { icon: Puzzle, label: () => t("插件規則不符"), tab: "plugins" },
  prompt: { icon: PenLine, label: () => t("修正 prompt"), tab: "prompt" },
  references: { icon: Images, label: () => t("檢查參考素材"), tab: "references" },
  shot: { icon: SlidersHorizontal, label: () => t("檢查鏡頭設定"), tab: "prompt" },
};

/** The way to fix what blocks the render; its tooltip lists every reason on its own line. */
function PreflightFix({ problem, kind, compact }: { problem: RenderProblem; kind: FixKind; compact: boolean }) {
  const { workspace } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const fix = FIX[kind];
  const Icon = fix.icon;
  const reasons = problem.items.length > 0 ? problem.items.map((item) => `• ${item}`).join("\n") : problem.text;
  const detail = problem.items.length > 0 ? problem.items.join(t("；")) : problem.text;
  const open = () => {
    revealInspectorTab(fix.tab);
    if (workspace !== "generate") void navigate({ pathname: "/studio/generate", search: `?${params.toString()}` });
  };
  return (
    <button
      type="button"
      onClick={open}
      title={reasons}
      aria-label={t("{label}：{detail}", { label: fix.label(), detail })}
      className="pressable inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-caption text-warning hover:bg-raised active:bg-sunken [&_svg]:size-3.5"
    >
      <Icon aria-hidden />
      {compact ? null : fix.label()}
    </button>
  );
}

// Memoised: it renders again with the project or the selection, not with every tick of a running render
const RenderShotButton = memo(function RenderShotButton({ shot, live, buttonRef, compact }: RenderShotButtonProps) {
  const { project, renderShots, busy, engine } = useStudio();
  const block = useRenderBlock(shot);
  // Components of the shot's route that load when the render uses them: the second line says so (the estimate moves to the tooltip)
  const load = useOnUseLoad(findRoute(engine.routes, shot.route));
  const shots = useMemo(() => [shot], [shot]);
  const eta = useRenderEta(shots);
  const descriptionId = useId();
  const status = shotStatus(shot, project);
  const reason = renderDisabledReason(block, busy) ?? block.problem ?? null;
  const lines = [...(load ? [onUseText(load)] : []), ...etaLines(eta), statusText(shot, project, live)];
  return (
    <div className="flex shrink-0 items-center gap-2">
      <ActionButton
        ref={buttonRef}
        size="md"
        variant="primary"
        icon={<RenderIcon status={status} />}
        pending={busy === "render"}
        disabledReason={reason}
        aria-describedby={descriptionId}
        onClick={() => {
          askRenderAlerts();
          void renderShots([shot.shot_id]);
        }}
        title={[t("渲染「{title}」（Ctrl+Enter）", { title: shot.title }), ...lines].join("\n")}
        className={BUTTON_CLASS}
      >
        <span className="grid justify-items-start leading-tight">
          <span>{t("渲染鏡頭")}</span>
          {load ? (
            <span className="flex items-center gap-1 text-[11px] font-normal animate-fade-in">{onUseText(load)}</span>
          ) : eta.eta ? (
            <span className="machine flex items-center gap-1 text-[11px] font-normal animate-fade-in">
              {t("約 {left}", { left: formatEtaClock(eta.eta.totalSeconds) })}
              {eta.risks.worst ? <TriangleAlert aria-hidden className="size-3!" /> : null}
            </span>
          ) : null}
        </span>
      </ActionButton>
      <span id={descriptionId} hidden>
        {lines.join("\n")}
      </span>
      {block.preflight && block.preflight.kind !== "engine" ? <PreflightFix problem={block.preflight} kind={block.preflight.kind} compact={compact} /> : null}
    </div>
  );
});
