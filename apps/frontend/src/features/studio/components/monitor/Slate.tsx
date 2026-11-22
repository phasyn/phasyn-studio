// What the monitor shows in place of a take without video. While the shot renders: the rendering slate (stage, time
// left, progress, cancel, the run in the Render workspace). Otherwise: the shot's title and state, one description line
// (the prompt's summary, the note, or its first lines), why the take shown ended, and 渲染這個鏡頭 with its estimate or
// the reason it cannot render, plus the fix for sampling values the DiT refuses.
import { Clapperboard } from "lucide-react";
import { useState } from "react";
import type { StudioShot, StudioTake } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { CancelRunDialog } from "@/components/common/CancelRunDialog";
import { returnFocusOr } from "@/components/ui/focusReturn";
import { cn } from "@/lib/cn";
import { t, tServer } from "@/i18n";
import { renderDisabledReason, useRenderBlock } from "../../hooks/useRenderBlock";
import { shotStatus } from "../../model/project";
import { useStudio } from "../../studioContext";
import { ShotStatusMark, TakeStateMark } from "../marks";
import { RenderEta } from "../RenderEta";
import { RenderingSlate, type CancelRequest } from "./RenderingSlate";
import { SamplingFix } from "./SamplingFix";
import { slateDescription } from "./slateText";
import { isEnded } from "./monitorTakes";

/** The color of an ended take's reason follows its mark: cancelled is neutral, interrupted a warning, failed an error. */
const END_TONE: Partial<Record<StudioTake["state"], string>> = { failed: "text-danger", cancelled: "text-fg-secondary", interrupted: "text-warning" };

/** 渲染這個鏡頭 (the same check as the properties panel's render button), its estimate or the reason, and the sampling fix. */
function SlateRenderAction({ shot }: { shot: StudioShot }) {
  const { renderShots, busy } = useStudio();
  const block = useRenderBlock(shot);
  const reason = renderDisabledReason(block, busy);
  // Several reasons (each rule of a plugin that does not hold, each reference problem): one line each, not one sentence
  const items = block.problem === null && block.preflight ? block.preflight.items : [];
  return (
    <div className="grid w-full justify-items-center gap-1.5">
      <ActionButton
        data-slate-action=""
        size="sm"
        icon={<Clapperboard aria-hidden />}
        pending={busy === "render"}
        disabledReason={reason}
        onClick={() => void renderShots([shot.shot_id])}
      >
        {t("渲染這個鏡頭")}
      </ActionButton>
      {items.length > 0 ? (
        <div className="grid max-w-sm gap-1 text-left text-caption text-fg-tertiary">
          <p className="text-center">{t("還不能渲染：")}</p>
          <ul aria-label={t("不能渲染的原因")} className="grid gap-1">
            {items.map((item) => (
              <li key={item} className="flex min-w-0 items-start gap-1.5">
                <span aria-hidden className="mt-[7px] size-1 shrink-0 rounded-full bg-warning" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (reason != null && reason !== "") ? (
        <p className="max-w-sm text-caption text-fg-tertiary [overflow-wrap:anywhere]">{reason}</p>
      ) : (
        <RenderEta shots={[shot]} className="justify-items-center" />
      )}
      <SamplingFix shot={shot} />
    </div>
  );
}

function IdleSlate({ shot, take }: { shot: StudioShot; take: StudioTake | null }) {
  const { project } = useStudio();
  const ended = take && isEnded(take) ? take : null;
  const description = slateDescription(shot);
  return (
    <div className="grid w-full max-w-md justify-items-center gap-3 text-center animate-rise-in">
      <span aria-hidden className="grid size-11 place-items-center rounded-xl border border-line bg-surface/70 text-fg-tertiary">
        <Clapperboard className="size-5" />
      </span>
      <h2 className="max-w-full text-body font-semibold text-fg [overflow-wrap:anywhere]">{shot.title}</h2>
      {ended ? <TakeStateMark state={ended.state} /> : <ShotStatusMark status={shotStatus(shot, project)} />}
      <p className="line-clamp-2 max-w-full text-data whitespace-pre-line text-fg-tertiary [overflow-wrap:anywhere]" title={description || undefined}>
        {description || t("還沒有 prompt")}
      </p>
      {ended?.error ? (
        <p className={cn("line-clamp-3 max-w-full text-caption [overflow-wrap:anywhere]", END_TONE[ended.state])} title={ended.error.code}>
          {tServer(ended.error.message)}
        </p>
      ) : null}
      <SlateRenderAction shot={shot} />
    </div>
  );
}

/** Where focus goes when a cancellation dialog closes after its button left with the render: the slate's own action. */
function slateFocusTarget(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-slate-action]") ?? document.querySelector<HTMLElement>('[data-take-card][tabindex="0"]');
}

export function Slate({ shot, take }: { shot: StudioShot; take: StudioTake | null }) {
  // The confirmation lives here, not in the rendering slate: it keeps its answer after the run ends and that slate leaves
  const [cancel, setCancel] = useState<CancelRequest | null>(null);
  const rendering = take?.state === "rendering" ? take : (shot.takes.find((item) => item.state === "rendering") ?? null);
  return (
    <div className="absolute inset-0 grid place-items-center overflow-y-auto p-6">
      {rendering ? <RenderingSlate key={rendering.take_id} shot={shot} take={rendering} onCancel={setCancel} /> : <IdleSlate shot={shot} take={take} />}
      {cancel ? (
        <CancelRunDialog
          run={cancel.run}
          open
          onOpenChange={(open) => { if (!(open)) { setCancel(null); } }}
          scope={cancel.scope}
          onCloseAutoFocus={(event) => { returnFocusOr(event, cancel.opener, slateFocusTarget()); }}
        />
      ) : null}
    </div>
  );
}
