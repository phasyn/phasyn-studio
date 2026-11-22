// 換角精靈的外框：頂端是共用的步驟流程（Stepper：每一步是按鈕，Tab 依序、Enter／Space 前往；另外保留方向鍵與 Home／End
// 在步驟之間移動焦點；目前步驟 aria-current="step"）、步驟內容（唯一的捲動區；換步驟時回到頂端並淡入）、
// 底部動作（上一步／下一步／建立）。建立開始後步驟流程只呈現、不能點；內容改成建立進度：另一條步驟流程＋每一步的狀態、
// 失敗原因與手動的下一步。
import { ArrowLeft, ArrowRight, CircleCheck, CircleDashed, CircleX, FolderOpen, LoaderCircle, RotateCcw, TriangleAlert, Wand } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { ComponentDescriptor, StudioLibraryItem } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { reveal, useContentSwapMotion } from "@/components/ui/motion";
import { Stepper, type StepperStep } from "@/components/workbench/Stepper";
import { cn } from "@/lib/cn";
import { CARD } from "@/components/ui/look";
import { STEP_IDS, type StepId } from "./draft";
import { REMOTE_UNKNOWN } from "./errors";
import type { SwapPluginsView } from "./plugins";
import type { ProbeSupport } from "./probe";
import { STEP_LABELS } from "./steps";
import type { DetectionView } from "./useCutDetection";
import { CREATE_STEPS, type CreateState } from "./useSwapCreate";
import type { SwapDraftApi } from "./useSwapDraft";
import { CharactersStep, CutsStep, OutputStep, PlanStep, SourceStep } from "./wizard";
import type { WizardDerived } from "./wizardModel";
import { t } from "@/i18n";

export interface SwapWizardProps {
  api: SwapDraftApi;
  derived: WizardDerived;
  problems: Record<StepId, string[]>;
  library: readonly StudioLibraryItem[];
  detection: DetectionView;
  probe: ComponentDescriptor | null;
  support: ProbeSupport;
  detectBlockedReason: string | null;
  /** 取消偵測的回應（未受理或失敗）；沒有時 null。 */
  detectNotice: string | null;
  cancellingDetection: boolean;
  onDetect: () => void;
  onCancelDetection: () => void;
  renderBlockedReason: string | null;
  /** The new project's plugin items and their check. */
  plugins: SwapPluginsView;
  create: CreateState;
  onCreate: () => void;
  onRetryCreate: () => void;
  onOpenCreated: () => void;
  onBackFromCreate: () => void;
}

export function SwapWizard(props: SwapWizardProps) {
  const { api, problems, create } = props;
  const step = api.draft.step;
  const index = STEP_IDS.indexOf(step);
  const goto = (next: StepId) => { api.update({ step: next }); };
  const creating = create.phase !== "idle";
  const blockedStep = STEP_IDS.find((id) => problems[id].length > 0) ?? null;
  const createReason = blockedStep ? t("{blockedStep}：{value}", { blockedStep: STEP_LABELS[blockedStep], value: problems[blockedStep][0] ?? "" }) : null;
  const startsRender = api.draft.startRender && !(props.renderBlockedReason != null && props.renderBlockedReason !== "");
  const swapMotion = useContentSwapMotion<HTMLDivElement>();
  // 步驟流程：目前步驟＝active；沒有待處理的問題＝done；還有問題＝pending（detail 是第一個問題，完整文字在 title 與底部提示）
  const flow: StepperStep[] = STEP_IDS.map((id) => {
    const issue = problems[id][0];
    return { id, label: STEP_LABELS[id], state: id === step ? "active" : (issue != null && issue !== "") ? "pending" : "done", ...(id !== step && (issue != null && issue !== "") ? { detail: issue } : {}) };
  });
  const select = (id: string) => {
    const next = STEP_IDS.find((item) => item === id);
    if (next) goto(next);
  };
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* 方向鍵／Home／End 在步驟之間移動焦點（沿用舊的步驟清單）；Enter／Space 前往由按鈕本身處理 */}
        <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- Keyboard events from this panel’s focusable controls bubble here so navigation and dismissal share one handler. */  className="shrink-0 border-b border-line-subtle px-6 py-3 max-md:px-4" onKeyDown={moveStepFocus}>
          <Stepper label={t("換角步驟")} steps={flow} {...(creating ? {} : { onSelect: select })} />
        </div>
        {/* 捲動區以步驟為 key：換步驟時從頂端開始；外層偵測到內容被換掉時淡入 */}
        <div ref={swapMotion} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div key={creating ? "create" : step} className="min-h-0 flex-1 overflow-y-auto px-6 py-4 max-md:px-4" role="region" aria-label={creating ? t("建立進度") : STEP_LABELS[step]}>
            {creating ? (
              <CreateProgress state={create} />
            ) : step === "source" ? (
              <SourceStep api={api} derived={props.derived} library={props.library} />
            ) : step === "characters" ? (
              <CharactersStep api={api} derived={props.derived} library={props.library} />
            ) : step === "cuts" ? (
              <CutsStep
                api={api}
                derived={props.derived}
                detection={props.detection}
                probe={props.probe}
                support={props.support}
                blockedReason={props.detectBlockedReason}
                notice={props.detectNotice}
                cancelling={props.cancellingDetection}
                onDetect={props.onDetect}
                onCancel={props.onCancelDetection}
              />
            ) : step === "plan" ? (
              <PlanStep api={api} derived={props.derived} />
            ) : (
              <OutputStep api={api} derived={props.derived} problems={problems} renderBlockedReason={props.renderBlockedReason} plugins={props.plugins} onGoto={goto} />
            )}
          </div>
        </div>
      </div>
      <DialogFooter className="justify-between">
        {creating ? (
          <CreateActions state={create} onRetry={props.onRetryCreate} onOpen={props.onOpenCreated} onBack={props.onBackFromCreate} />
        ) : (
          <>
            <p className="min-w-0 flex-1 truncate text-caption text-warning" title={problems[step][0]}>
              {(problems[step][0] != null && problems[step][0] !== "") ? (
                <>
                  <TriangleAlert aria-hidden className="mr-1 inline size-3.5 align-[-2px]" />
                  {problems[step][0]}
                </>
              ) : null}
            </p>
            <div className="flex items-center gap-2">
              {/* 停用時仍可聚焦（ActionButton）：回到第一步時焦點不會掉到頁面上 */}
              <ActionButton variant="secondary" icon={<ArrowLeft aria-hidden />} disabledReason={index <= 0 ? t("已經是第一步") : null} onClick={() => { goto(STEP_IDS[index - 1] ?? step); }}>
                {t("上一步")}
              </ActionButton>
              {index < STEP_IDS.length - 1 ? (
                <ActionButton variant="secondary" icon={<ArrowRight aria-hidden />} disabledReason={problems[step][0] ?? null} onClick={() => { goto(STEP_IDS[index + 1] ?? step); }}>
                  {t("下一步")}
                </ActionButton>
              ) : (
                <ActionButton variant="primary" icon={<Wand aria-hidden />} disabledReason={createReason} onClick={props.onCreate}>
                  {startsRender ? t("建立專案並開始渲染") : t("建立專案")}
                </ActionButton>
              )}
            </div>
          </>
        )}
      </DialogFooter>
    </>
  );
}

/** 步驟流程的方向鍵：←↑／→↓ 移到前後一步（循環）、Home／End 到頭尾；只移焦點（建立中步驟不是按鈕，沒有作用）。 */
function moveStepFocus(event: KeyboardEvent<HTMLDivElement>) {
  const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")];
  const index = buttons.findIndex((button) => button === event.target);
  if (index < 0) return;
  const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  const next = event.key === "Home" ? buttons[0] : event.key === "End" ? buttons.at(-1) : delta ? buttons[(index + delta + buttons.length) % buttons.length] : undefined;
  if (!next) return;
  event.preventDefault();
  next.focus();
}

const STEP_STATE = {
  pending: { icon: CircleDashed, className: "text-fg-tertiary", label: t("等待") },
  running: { icon: LoaderCircle, className: "text-info [&_svg]:animate-spin", label: t("進行中") },
  done: { icon: CircleCheck, className: "text-success", label: t("完成") },
  failed: { icon: CircleX, className: "text-danger", label: t("失敗") },
  skipped: { icon: CircleDashed, className: "text-fg-tertiary", label: t("略過") },
} as const;

/**
 * 建立步驟的狀態 → 步驟流程的狀態。略過＝沒有勾選「建立後立即開始渲染」，這次不會渲染也不會寫回：唸「已略過」，
 * 不說「尚未開始」（另外標「略過」）。
 */
const CREATE_FLOW: Record<CreateState["steps"][keyof CreateState["steps"]]["state"], StepperStep["state"]> = {
  pending: "pending",
  running: "active",
  done: "done",
  failed: "error",
  skipped: "skipped",
};

function CreateProgress({ state }: { state: CreateState }) {
  const flow: StepperStep[] = CREATE_STEPS.map((item) => {
    const step = state.steps[item.id];
    return { id: item.id, label: item.label, state: CREATE_FLOW[step.state], ...(step.state === "skipped" ? { detail: t("略過") } : {}) };
  });
  return (
    <div className="grid gap-4">
      <Stepper label={t("建立步驟")} steps={flow} />
      <ol className="grid gap-2" aria-label={t("建立步驟的詳細狀態")}>
        {CREATE_STEPS.map((item, index) => {
          const step = state.steps[item.id];
          const spec = STEP_STATE[step.state];
          return (
            <li
              key={item.id}
              ref={reveal(index)}
              className={cn(CARD, "grid grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 gap-y-0.5 px-3 py-2 transition-[border-color] duration-(--duration-base) ease-standard", step.state === "running" ? "border-brand-blue/45" : step.state === "failed" ? "border-danger/45" : null)}
            >
              <span className={cn("row-span-2 mt-0.5 [&_svg]:size-4", spec.className)}>
                <spec.icon aria-hidden />
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-data text-fg">
                <span className="min-w-0 [overflow-wrap:anywhere]">{item.label}</span>
                <span className={cn("text-caption", spec.className)}>{spec.label}</span>
              </span>
              {(step.detail != null && step.detail !== "") ? <span className={cn("text-caption [overflow-wrap:anywhere]", step.state === "failed" ? "text-danger" : "text-fg-tertiary")}>{step.detail}</span> : <span />}
            </li>
          );
        })}
      </ol>
      {state.phase === "failed" && state.unknown ? <p className="text-caption text-warning">{t("{remoteUnknown}。", { remoteUnknown: REMOTE_UNKNOWN })}</p> : null}
      {state.phase === "done" ? (
        <p role="status" className="flex items-center gap-1.5 text-caption text-success animate-rise-in">
          <CircleCheck aria-hidden className="size-3.5" />
          {t("完成，正在開啟新專案…")}
        </p>
      ) : null}
    </div>
  );
}

function CreateActions({ state, onRetry, onOpen, onBack }: { state: CreateState; onRetry: () => void; onOpen: () => void; onBack: () => void }) {
  const failedStep = CREATE_STEPS.find(({ id }) => state.steps[id].state === "failed")?.id;
  // 連線中斷的 run 建立結果未知：不提供重送（避免重複的 GPU 工作），先開啟專案或到紀錄確認
  const canRetry = state.phase === "failed" && !(failedStep === "render" && state.unknown);
  return (
    <>
      <p role={state.phase === "failed" ? "alert" : "status"} aria-live="polite" className={cn("min-w-0 flex-1 text-caption [overflow-wrap:anywhere]", state.phase === "failed" ? "text-danger" : "text-fg-tertiary")}>
        {state.phase === "running" ? t("建立中：每個寫入只送一次；關掉對話框不會中斷。") : state.phase === "failed" ? state.error : t("完成")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {state.phase === "failed" && !state.project ? (
          <Button variant="secondary" icon={<ArrowLeft aria-hidden />} onClick={onBack}>
            {t("回到設定")}
          </Button>
        ) : null}
        {state.project ? (
          <Button variant="secondary" icon={<FolderOpen aria-hidden />} disabled={state.phase === "running"} onClick={onOpen}>
            {t("開啟新專案")}
          </Button>
        ) : null}
        {state.phase === "running" ? (
          <Button variant="primary" pending>
            {t("建立中")}
          </Button>
        ) : canRetry ? (
          <Button variant="primary" icon={<RotateCcw aria-hidden />} onClick={onRetry}>
            {t("從失敗的步驟再試一次")}
          </Button>
        ) : null}
      </div>
    </>
  );
}
