// 一鍵換角的入口：對話框一直掛載；工具列按鈕只在換角專案或建立進行中出現，新的換角從專案管理的「新增專案」開始。對話框有兩個畫面——
// 「換角工作」（這個專案是一鍵換角建立的：進度、取消、單段重新渲染、匯出與結果）與「新的換角」（五步精靈）。
// 精靈的草稿、切鏡偵測與建立進度都放在這裡：關掉對話框不會遺失輸入，建立中關掉也不會中斷。建立完成後開啟新專案，
// 網址帶 ?swap=1 讓新專案一打開就顯示工作畫面（開關狀態由網址推導，關閉時移除參數）。
// 換角專案的自動匯出（useSwapJob）也掛在這裡：對話框關著、在任何工作區都會在全部段落完成後匯出一次。
import { History, LoaderCircle, Replace } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { LazyBoundary } from "@/components/common/LazyBoundary";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useContentSwapMotion } from "@/components/ui/motion";
import { LoadingPanels } from "@/features/studio-shell";
import { pluginText, selectedItems } from "@/features/plugins";
import { cn } from "@/lib/cn";
import { FORMAT_PRESETS } from "../model/project";
import { engineUnavailable } from "../model/routes";
import { videoLibrary } from "../references/materials";
import { useStudio } from "../studioContext";
import { nextBatch, swapBatchSize } from "./batchSize";
import { segmentSettings } from "./draft";
import { clearDraft, loadDraft, lostImages, useDraftAutosave } from "./draftStore";
import { findSwapJob, segmentPrompts, segmentTitle, soundtrackSent, SWAP_URL_PARAM } from "./job";
import { swapPluginProblem, swapPluginRefs, type SwapPluginsView } from "./plugins";
import { toolbarSummary, type SummaryTone } from "./jobView";
import { pickProbeComponent, probeSupport } from "./probe";
import { useCutDetection } from "./useCutDetection";
import { useSwapCreate, type CreateRequest } from "./useSwapCreate";
import { useSwapDraft } from "./useSwapDraft";
import { useSwapJob } from "./useSwapJob";
import { deriveWizard, detectionStatus, stepProblems } from "./wizardModel";
import { t } from "@/i18n";
import { formatDateTime, formatList } from "@/i18n/format";

// The dialog's two screens load on first open (the launcher button and the auto-export watcher stay in the page chunk)
const SwapJobPanel = lazy(() => import("./SwapJobPanel").then((m) => ({ default: m.SwapJobPanel })));
const SwapWizard = lazy(() => import("./SwapWizard").then((m) => ({ default: m.SwapWizard })));

const CHIP_TONE: Record<SummaryTone, string> = {
  info: "text-info",
  warning: "text-warning",
  success: "text-success",
  danger: "text-danger",
  neutral: "text-fg-tertiary",
};

type Mode = "job" | "wizard";

/**
 * iconOnly: the toolbar is out of room (StudioToolbar's fit level 2); below the lg viewport the button is always
 * icon-only. bare: the toolbar's last level, the progress text goes too (it stays in the tooltip and aria-label).
 */
export function SwapLauncher({ iconOnly = false, bare = false }: { iconOnly?: boolean; bare?: boolean }) {
  const { project, setEngineOpen } = useStudio();
  const info = useMemo(() => findSwapJob(project), [project]);
  const job = useSwapJob(info);
  // The unfinished draft survives a reload, a deploy or opening another project (this browser only, draftStore): read
  // once when the toolbar mounts, kept after every change, cleared when its project is created or on 重新開始
  const [saved] = useState(loadDraft);
  const draft = useSwapDraft(saved);
  const detection = useCutDetection(draft.draft.source?.key ?? null, saved?.detection ?? null);
  const creation = useSwapCreate();
  const [restored, setRestored] = useState<Restored | null>(() => (saved ? { savedAt: saved.savedAt, lostImages: lostImages(saved) } : null));
  useDraftAutosave(draft.draft, detection.saved);
  const startOver = () => {
    clearDraft();
    draft.reset();
    setRestored(null);
  };
  const [params, setParams] = useSearchParams();
  const [openState, setOpenState] = useState(false);
  const [modeState, setModeState] = useState<Mode | null>(null);
  /** 使用者在對話框內切換了畫面：新畫面掛上時把焦點移到標題。 */
  const [switched, setSwitched] = useState(false);
  const switchTo = (next: Mode) => {
    setModeState(next);
    setSwitched(true);
  };
  const requested = params.get(SWAP_URL_PARAM) === "1";
  const open = openState || requested;
  const creating = creation.state.phase !== "idle";
  // 換角專案預設看工作畫面；建立進行中（或失敗待處理）時回到精靈的建立進度
  const mode: Mode = !info || !job.progress ? "wizard" : (modeState ?? (creating ? "wizard" : "job"));
  // 按鈕上的狀態：換角專案的進度；建立中（對話框關著也繼續）或建立沒完成時改顯示建立狀態
  const summary =
    creation.state.phase === "running"
      ? { text: t("建立中"), detail: t("正在建立新專案（每個寫入只送一次）"), title: t("一鍵換角：正在建立新專案（每個寫入只送一次）"), tone: "info" as const, busy: true }
      : creation.state.phase === "failed"
        ? { text: t("建立未完成"), detail: t("建立沒有完成——{value}", { value: creation.state.error ?? "" }), title: t("一鍵換角：建立沒有完成——{value}", { value: creation.state.error ?? "" }), tone: "warning" as const, busy: false }
        : job.progress
          ? toolbarSummary(job.progress)
          : null;
  const contentSwap = useContentSwapMotion<HTMLDivElement>();

  const setOpen = (next: boolean) => {
    setOpenState(next);
    if (next) return;
    setModeState(null);
    setSwitched(false);
    if (requested) {
      setParams(
        (current) => {
          const out = new URLSearchParams(current);
          out.delete(SWAP_URL_PARAM);
          return out;
        },
        { replace: true },
      );
    }
  };

  const label = summary ? t("一鍵換角（{detail}）", { detail: summary.detail }) : t("一鍵換角：把影片中的角色換成你的角色圖");
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* 工具列只在換角專案或建立進行中顯示按鈕；新的換角從「新增專案」開始（?swap=1 開啟精靈） */}
      {info || summary ? (
      <DialogTrigger asChild>
        <Button
          size="sm"
          variant="secondary"
          icon={(summary?.busy === true) ? <LoaderCircle aria-hidden className="animate-spin" /> : <Replace aria-hidden />}
          title={summary?.title ?? t("一鍵換角：依切鏡自動分段、批次渲染並接成一支影片（建立新專案）")}
          aria-label={label}
          className="shrink-0"
        >
          {/* 工具列擠不下時只留圖示（名稱仍在 aria-label 與 title） */}
          <span className={cn("max-lg:sr-only", iconOnly && "sr-only")}>{t("一鍵換角")}</span>
          {summary && !bare ? <span className={cn("machine text-caption font-normal", CHIP_TONE[summary.tone])}>{summary.text}</span> : null}
        </Button>
      </DialogTrigger>
      ) : null}
      <DialogContent wide className="h-[min(88vh,52rem)] max-w-6xl">
        {/* 工作畫面與精靈互換時淡入 */}
        <div ref={contentSwap} className="flex min-h-0 flex-1 flex-col">
          {mode === "job" && info && job.progress ? (
            <div key="job" className="flex min-h-0 flex-1 flex-col">
              <LazyBoundary className="m-4">
                {/* While the job screen loads, the dialog keeps its title (an accessible name) */}
                <Suspense fallback={<ScreenLoading />}>
                  <SwapJobPanel
                    info={info}
                    job={job}
                    progress={job.progress}
                    focusTitle={switched}
                    onNewSwap={() => { switchTo("wizard"); }}
                    onNavigate={() => { setOpen(false); }}
                    onOpenEngine={() => {
                      setOpen(false);
                      setEngineOpen(true);
                    }}
                  />
                </Suspense>
              </LazyBoundary>
            </div>
          ) : (
            <div key="wizard" className="flex min-h-0 flex-1 flex-col">
              <WizardHost
                draft={draft}
                detection={detection}
                creation={creation}
                focusTitle={switched}
                onShowJob={info ? () => { switchTo("job"); } : null}
                restored={restored}
                onStartOver={startOver}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The job screen while its code loads: the dialog keeps its title (its accessible name) above the skeleton. */
function ScreenLoading() {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("一鍵換角")}</DialogTitle>
      </DialogHeader>
      <LoadingPanels label={t("載入一鍵換角…")} panels={1} />
    </>
  );
}

/** A draft restored from this browser: when it was kept, and the images from this computer that were not kept. */
interface Restored {
  savedAt: string;
  lostImages: string[];
}

/** Says that the wizard continues a draft kept in this browser, and offers to start over. */
function RestoredNote({ restored, onStartOver }: { restored: Restored; onStartOver: () => void }) {
  const time = Number.isNaN(Date.parse(restored.savedAt)) ? restored.savedAt : formatDateTime(restored.savedAt);
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-info/30 bg-info/8 px-2.5 py-1.5 text-caption text-info animate-reveal">
      <History aria-hidden className="size-3.5 shrink-0" />
      <div className="grid min-w-0 flex-1 gap-0.5 [overflow-wrap:anywhere]">
        <p>{t("已恢復這個瀏覽器上次沒完成的設定（{time}）。", { time })}</p>
        {restored.lostImages.length > 0 ? <p>{t("用「上傳圖片」選的角色圖沒有保存，請重新上傳：{names}", { names: formatList(restored.lostImages) })}</p> : null}
      </div>
      <Button size="sm" variant="quiet" onClick={onStartOver} className="min-h-7 px-2">
        {t("重新開始")}
      </Button>
    </div>
  );
}

/** 精靈：由草稿推導分段與各步驟的問題，組成建立請求。 */
function WizardHost({
  draft: api,
  detection,
  creation,
  focusTitle,
  onShowJob,
  restored,
  onStartOver,
}: {
  draft: ReturnType<typeof useSwapDraft>;
  detection: ReturnType<typeof useCutDetection>;
  creation: ReturnType<typeof useSwapCreate>;
  /** 由工作畫面切換過來：焦點移到標題。 */
  focusTitle: boolean;
  onShowJob: (() => void) | null;
  /** The draft was restored from this browser. */
  restored: Restored | null;
  onStartOver: () => void;
}) {
  const { project, engine, catalog, runBlockedReason, plugins } = useStudio();
  const { draft } = api;
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusTitle) titleRef.current?.focus();
  }, [focusTitle]);
  const derived = useMemo(() => deriveWizard(draft, { probe: detection.probe, routes: engine.routes }), [draft, detection.probe, engine.routes]);
  const batchSize = swapBatchSize.use();
  const problems = stepProblems(draft, derived, {
    detection: detectionStatus(detection.view),
    detectionMessage: detection.view.status === "failed" ? detection.view.message : null,
    engineReady: engine.status === "ready",
  });
  const probeComponent = useMemo(() => pickProbeComponent(catalog, derived.route?.ditNodeId ?? null), [catalog, derived.route]);
  const support = probeSupport(probeComponent);
  const [cancelMessage, setCancelMessage] = useState<string | null>(null);
  const source = draft.source;
  const detectBlockedReason = !source ? t("先在「來源影片」選擇影片") : draft.sourceUpload && draft.sourceUpload.state !== "failed" ? t("來源影片還在上傳") : runBlockedReason;
  const route = derived.route;
  // The new project's plugin items (the current project's unless the wizard left some out) and their check against
  // every segment prompt: a selection that would block a segment keeps 建立 unavailable, with the reason
  const pluginRefs = useMemo(() => swapPluginRefs(draft.plugins, project), [draft.plugins, project]);
  const segmentChecks = useMemo(() => {
    const { notes, absent } = segmentSettings(draft, derived.plan);
    const prompts = segmentPrompts({ plan: derived.plan, notes, absent, style: draft.style, dialogueLanguage: draft.dialogueLanguage, characters: draft.characters, hasAudio: soundtrackSent(draft.audio, derived.facts?.has_audio) });
    return prompts.map((item, index) => ({ ...item, title: segmentTitle(derived.plan, index) }));
  }, [draft, derived.plan, derived.facts]);
  const formatPreset = FORMAT_PRESETS.find((item) => item.id === draft.format) ?? FORMAT_PRESETS[0];
  const pluginProblem = useMemo(() => {
    const format = formatPreset ? { ...project.format, width: formatPreset.width, height: formatPreset.height } : project.format;
    return swapPluginProblem(segmentChecks, pluginRefs, { project: { ...project, format }, route: route ?? null }, plugins);
  }, [segmentChecks, pluginRefs, project, formatPreset, route, plugins]);
  if (pluginProblem) problems.output.push(t("「{title}」不符合所選插件：{reason}", { title: pluginProblem.title, reason: pluginProblem.reasons[0] ?? "" }));
  const pluginView: SwapPluginsView = {
    items: selectedItems(plugins, project.prompt_plugins).map((item) => ({ ref: item.ref, label: item.contribution?.label ?? item.ref, plugin: item.contribution ? pluginText(item.contribution.plugin.name, item.contribution.plugin.plugin_id) : "" })),
    refs: pluginRefs,
    problem: pluginProblem,
  };
  const renderBlockedReason = engineUnavailable(engine) ?? runBlockedReason ?? (route && !route.ready ? t("元件組合「{label}」未就緒：{summary}", { label: route.label, summary: route.summary }) : null);

  const request = (): CreateRequest | null => {
    const preset = FORMAT_PRESETS.find((item) => item.id === draft.format) ?? FORMAT_PRESETS[0];
    const facts = derived.facts;
    if (!source || !route || !preset || !facts) return null;
    const { notes, absent } = segmentSettings(draft, derived.plan);
    return {
      build: {
        title: draft.title.trim(),
        width: preset.width,
        height: preset.height,
        routeId: route.id,
        source: { name: source.name, file: source.file, duration_seconds: facts.duration_seconds, width: facts.width, height: facts.height, has_audio: facts.has_audio },
        plan: derived.plan,
        notes,
        absent,
        style: draft.style,
        dialogueLanguage: draft.dialogueLanguage,
        audio: draft.audio,
        autoExport: draft.autoExport,
        plugins: pluginRefs,
      },
      characters: draft.characters,
      startRender: draft.startRender && !(renderBlockedReason != null && renderBlockedReason !== ""),
      firstBatch: nextBatch(derived.plan.segments.map((_, index) => String(index)), derived.perRun, batchSize).length,
      routes: engine.routes,
      catalog,
    };
  };

  return (
    <>
      <DialogHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <DialogTitle ref={titleRef} tabIndex={-1}>
            {t("一鍵換角")}
          </DialogTitle>
          {onShowJob ? (
            <Button size="sm" variant="quiet" onClick={onShowJob} title={t("回到這個專案的換角進度")}>
              {t("回到「{title}」的換角工作", { title: project.title })}
            </Button>
          ) : null}
        </div>
        <DialogDescription>
          {t("把影片裡的角色換成你的角色圖：依原影片的切鏡自動分段、在同一張卡依序渲染，再接成一支影片（預設用生成的聲音：台詞照每段備註的 <d> 生成，嘴型與聲線跟新角色一致）。會建立新的 Studio 專案，目前的專案不會被修改。")}
        </DialogDescription>
        {restored ? <RestoredNote restored={restored} onStartOver={onStartOver} /> : null}
      </DialogHeader>
      {/* The header above stays while the wizard's code loads: the dialog always has its title (accessible name) */}
      <LazyBoundary className="m-4">
        <Suspense fallback={<LoadingPanels label={t("載入一鍵換角…")} panels={1} />}>
          <SwapWizard
            api={api}
            derived={derived}
            problems={problems}
            library={videoLibrary(project.library ?? [])}
            detection={detection.view}
            probe={probeComponent}
            support={support}
            detectBlockedReason={detectBlockedReason}
            detectNotice={cancelMessage}
            cancellingDetection={detection.cancelling}
            onDetect={() => {
              if (!probeComponent || !source) return;
              setCancelMessage(null);
              void detection.start(probeComponent, source.file, draft.scene, source.name);
            }}
            onCancelDetection={() => void detection.cancel().then(setCancelMessage)}
            renderBlockedReason={renderBlockedReason}
            plugins={pluginView}
            create={creation.state}
            onCreate={() => {
              const body = request();
              if (body) creation.start(body);
            }}
            onRetryCreate={() => {
              const body = request();
              if (body) creation.retry(body);
            }}
            onOpenCreated={creation.openProject}
            onBackFromCreate={creation.reset}
          />
        </Suspense>
      </LazyBoundary>
    </>
  );
}
