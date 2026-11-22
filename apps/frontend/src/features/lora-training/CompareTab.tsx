// 強度比較：同一個 Prompt、同一個 seed，在每個 LoRA 強度各渲染一次，排成格子同步播放（一個播放鍵控制全部）。
// 「A/B 盲選」把「不用 LoRA」和一個強度隨機放左右，逐題選比較好的，最後才揭曉；決定要保留（登錄成 LoRA）或捨棄。
import { CheckCircle2, Eye, Pause, Play, RotateCcw, ThumbsDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FileRef, LoraTraining } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { SegmentedTabs } from "@/components/flow/SegmentedTabs";
import { Button } from "@/components/ui/button";
import { CARD, CHOICE_BASE, CHOICE_IDLE, CHOICE_SELECTED, PANEL_TITLE } from "@/components/ui/look";
import { StatusChip } from "@/components/workbench/StatusChip";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { isRecord } from "@/lib/json";
import { evalItems, formatStrength, rounds, type EvalItem, type RouteView } from "./model";
import { useAction } from "./useAction";

function followLead(list: HTMLVideoElement[]): void {
  const lead = list[0];
  if (!lead) return;
  for (const v of list.slice(1)) if (Math.abs(v.currentTime - lead.currentTime) > 0.08) v.currentTime = lead.currentTime;
}

function seekAll(list: Iterable<HTMLVideoElement>, at: number): void {
  for (const v of list) v.currentTime = at;
}

function playAll(list: HTMLVideoElement[], play: boolean): void {
  for (const v of list) {
    if (play) void v.play().catch(() => undefined);
    else v.pause();
  }
}

/** One play / pause and one scrubber for every video of the grid; the others follow the first one. */
function useSyncedVideos() {
  const videosRef = useRef(new Set<HTMLVideoElement>());
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState({ at: 0, duration: 0 });
  useEffect(() => {
    if (!playing) return undefined;
    const id = window.setInterval(() => {
      const list = [...videosRef.current];
      const lead = list[0];
      if (!lead) return;
      setTime({ at: lead.currentTime, duration: lead.duration || 0 });
      followLead(list);
    }, 120);
    return () => { window.clearInterval(id); };
  }, [playing]);
  const register = (node: HTMLVideoElement | null) => {
    if (node) videosRef.current.add(node);
  };
  const toggle = () => {
    const list = [...videosRef.current].filter((v) => v.isConnected);
    videosRef.current = new Set(list);
    playAll(list, !playing);
    setPlaying(!playing);
  };
  const seek = (at: number) => {
    seekAll(videosRef.current, at);
    setTime((prev) => ({ ...prev, at }));
  };
  return { register, playing, toggle, seek, time };
}

function Transport({ sync }: { sync: ReturnType<typeof useSyncedVideos> }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 rounded-lg border border-line-subtle bg-canvas/90 p-2 backdrop-blur">
      <Button variant="primary" size="sm" icon={sync.playing ? <Pause aria-hidden /> : <Play aria-hidden />} onClick={sync.toggle}>
        {sync.playing ? t("全部暫停") : t("全部播放")}
      </Button>
      <input
        type="range"
        min={0}
        max={Math.max(sync.time.duration, 0.01)}
        step={1 / 24}
        value={sync.time.at}
        onChange={(e) => { sync.seek(Number(e.target.value)); }}
        aria-label={t("同步播放位置")}
        className="min-w-0 flex-1 accent-[var(--color-brand-cyan)]"
      />
      <span className="machine w-20 shrink-0 text-right text-caption text-fg-tertiary">{`${sync.time.at.toFixed(1)} / ${sync.time.duration.toFixed(1)} s`}</span>
    </div>
  );
}

function Video({ file, label, register }: { file: FileRef | null; label: string; register: (node: HTMLVideoElement | null) => void }) {
  if (file === null) return <div className="grid aspect-video place-items-center rounded-md bg-stage text-caption text-fg-tertiary">{t("還沒算好")}</div>;
  return <video ref={register} src={mediaUrl(file.node_id, file.file_id)} aria-label={label} muted loop playsInline preload="metadata" className="aspect-video w-full rounded-md bg-stage object-contain" />;
}

function ItemHead({ item }: { item: EvalItem }) {
  return (
    <div className="grid gap-1">
      <span className="text-caption text-fg-tertiary">{item.kind === "heldout" ? t("留出影片的參考與 caption") : t("自訂比較")}</span>
      {item.sheet ? <img src={mediaUrl(item.sheet.node_id, item.sheet.file_id)} alt={t("參考片段")} className="h-auto w-full max-w-md rounded-md bg-stage" loading="lazy" /> : null}
      <p className="line-clamp-3 text-data text-fg-secondary" title={item.prompt}>{item.prompt}</p>
    </div>
  );
}

function Grid({ route, items }: { route: RouteView; items: EvalItem[] }) {
  const sync = useSyncedVideos();
  if (route.status === "skipped") return <p className="text-data text-fg-secondary">{t("這條路線略過了：比較用的 DiT 沒辦法套這個 LoRA。")}</p>;
  return (
    <div className="grid gap-3">
      <Transport sync={sync} />
      {items.map((item, i) => (
        <section key={item.eval_id} className={cn(CARD, "grid gap-3 p-3")} aria-label={t("比較題目 {n}", { n: i + 1 })}>
          <ItemHead item={item} />
          <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-2">
            {route.cells.map((cell) => (
              <figure key={cell.strength} className="grid gap-1">
                <Video file={cell.assets[i] ?? null} label={t("強度 {s}", { s: formatStrength(cell.strength) })} register={sync.register} />
                <figcaption className="flex items-center gap-2 text-caption">
                  <span className="machine font-semibold text-fg">{formatStrength(cell.strength)}</span>
                  {cell.state !== "done" ? <StatusChip tone="info" label={cell.state === "waiting" ? t("準備中") : t("渲染中")} spinning /> : null}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function seededOrder(seed: string, n: number): boolean[] {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Array.from({ length: n }, (_, i) => ((h >>> (i % 24)) & 1) === 1);
}

function BlindAB({ route, items, strength, jobId }: { route: RouteView; items: EvalItem[]; strength: number; jobId: string }) {
  const sync = useSyncedVideos();
  const base = route.cells.find((c) => c.strength === 0);
  const cell = route.cells.find((c) => c.strength === strength);
  const flip = useMemo(() => seededOrder(`${jobId}:${route.route_id}:${String(strength)}`, items.length), [jobId, route.route_id, strength, items.length]);
  const [picks, setPicks] = useState<Record<number, "A" | "B">>({});
  const [revealed, setRevealed] = useState(false);
  if (!base || !cell) return null;
  const done = Object.keys(picks).length === items.length;
  const loraWins = items.filter((_, i) => (picks[i] === "A") === flip[i] && picks[i] !== undefined).length;
  return (
    <div className="grid gap-3">
      <Transport sync={sync} />
      {items.map((item, i) => {
        const swap = flip[i] === true;
        const a = swap ? cell.assets[i] : base.assets[i];
        const b = swap ? base.assets[i] : cell.assets[i];
        return (
          <section key={item.eval_id} className={cn(CARD, "grid gap-3 p-3")} aria-label={t("盲選題目 {n}", { n: i + 1 })}>
            <p className="line-clamp-2 text-data text-fg-secondary">{item.prompt}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {(["A", "B"] as const).map((side) => (
                <figure key={side} className="grid gap-1">
                  <Video file={(side === "A" ? a : b) ?? null} label={t("選項 {side}", { side })} register={sync.register} />
                  <button type="button" aria-pressed={picks[i] === side} onClick={() => { setPicks((p) => ({ ...p, [i]: side })); }}
                    className={cn(CHOICE_BASE, "min-h-10 rounded-md text-data font-semibold", picks[i] === side ? CHOICE_SELECTED : CHOICE_IDLE)}>
                    {revealed ? t("{side}：{value}", { side, value: (side === "A") === swap ? formatStrength(strength) : formatStrength(0) }) : t("{side} 比較好", { side })}
                  </button>
                </figure>
              ))}
            </div>
          </section>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button icon={<Eye aria-hidden />} disabled={!done} onClick={() => { setRevealed(true); }}>{t("揭曉")}</Button>
        <Button variant="quiet" icon={<RotateCcw aria-hidden />} onClick={() => { setPicks({}); setRevealed(false); }}>{t("重選")}</Button>
        {revealed ? <span className="text-data text-fg">{t("LoRA 在 {wins}／{total} 題比較好", { wins: loraWins, total: items.length })}</span> : null}
      </div>
    </div>
  );
}

function Decide({ job, strengths }: { job: LoraTraining; strengths: number[] }) {
  const action = useAction(job.training_id);
  const [choice, setChoice] = useState<number | null>(null);
  const registered = isRecord(job.registered) ? job.registered : null;
  if (registered !== null) {
    return (
      <div className={cn(CARD, "flex flex-wrap items-center gap-3 border-success/40 p-4")}>
        <CheckCircle2 aria-hidden className="size-5 text-success" />
        <p className="text-data text-fg">{t("已登錄成 LoRA「{id}」：在元件的 LoRA 清單可以選它，也能和 8 步加速一起疊加。", { id: String(registered["lora_id"]) })}</p>
      </div>
    );
  }
  if (job.phase === "discarded") return <p className={cn(CARD, "p-4 text-data text-fg-secondary")}>{t("這個 LoRA 已捨棄。")}</p>;
  if (job.phase !== "decide") return null;
  return (
    <section className={cn(CARD, "grid gap-3 border-action/40 p-4")} aria-labelledby="decide-title">
      <h2 id="decide-title" className={PANEL_TITLE}>{t("要保留這個 LoRA 嗎？")}</h2>
      <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t("建議強度")}>
        {strengths.filter((s) => s > 0).map((s) => (
          <button key={s} type="button" role="radio" aria-checked={choice === s} onClick={() => { setChoice(s); }}
            className={cn(CHOICE_BASE, "machine min-h-9 rounded-md px-3 text-data", choice === s ? CHOICE_SELECTED : CHOICE_IDLE)}>
            {formatStrength(s)}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<CheckCircle2 aria-hidden />} disabled={choice === null} pending={action.pending === "decide"}
          onClick={() => void action.run({ action: "decide", choice: "keep", strength: choice ?? 1 })}>
          {t("保留並登錄")}
        </Button>
        <Button variant="danger" icon={<ThumbsDown aria-hidden />} pending={action.pending === "decide"} onClick={() => void action.run({ action: "decide", choice: "discard" })}>
          {t("沒有幫助，捨棄")}
        </Button>
      </div>
      {action.error !== null ? <ErrorCallout error={action.error} write title={t("沒有保存決定")} /> : null}
    </section>
  );
}

export function CompareTab({ job }: { job: LoraTraining }) {
  const all = rounds(job);
  const items = evalItems(job);
  const [roundIndex, setRoundIndex] = useState<number | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [mode, setMode] = useState<"grid" | "ab">("grid");
  const [abStrength, setAbStrength] = useState<number | null>(null);
  if (all.length === 0) return <p className="text-data text-fg-secondary">{t("訓練到比較點後，這裡會出現同一個 Prompt 在不同強度下的結果。")}</p>;
  const round = all[roundIndex ?? all.length - 1] ?? all[all.length - 1];
  if (!round) return null;
  const route = round.routes.find((r) => r.route_id === routeId) ?? round.routes[0];
  const strengths = route?.cells.map((c) => c.strength) ?? [];
  const ab = abStrength ?? strengths.find((s) => s > 0) ?? null;
  return (
    <div className="grid gap-4">
      <Decide job={job} strengths={strengths} />
      <div className="flex flex-wrap items-center gap-3">
        {all.length > 1 ? (
          <SegmentedTabs idPrefix={`rounds-${job.training_id}`} label={t("比較的訓練步數")} value={String(round.step)}
            onChange={(id) => { setRoundIndex(all.findIndex((r) => String(r.step) === id)); }}
            tabs={all.map((r) => ({ id: String(r.step), label: r.final ? t("最後（第 {step} 步）", { step: r.step }) : t("第 {step} 步", { step: r.step }) }))} />
        ) : null}
        {round.routes.length > 1 ? (
          <SegmentedTabs idPrefix={`routes-${job.training_id}`} label={t("渲染流程")} value={route?.route_id ?? ""} onChange={setRouteId}
            tabs={round.routes.map((r) => ({ id: r.route_id, label: r.label }))} />
        ) : null}
        <SegmentedTabs idPrefix={`mode-${job.training_id}`} label={t("比較方式")} value={mode} onChange={(id) => { setMode(id === "ab" ? "ab" : "grid"); }}
          tabs={[{ id: "grid", label: t("強度格子") }, { id: "ab", label: t("A/B 盲選") }]} />
        {mode === "ab" ? (
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("盲選的強度")}>
            {strengths.filter((s) => s > 0).map((s) => (
              <button key={s} type="button" role="radio" aria-checked={ab === s} onClick={() => { setAbStrength(s); }}
                className={cn(CHOICE_BASE, "machine min-h-9 rounded-md px-3 text-data", ab === s ? CHOICE_SELECTED : CHOICE_IDLE)}>
                {formatStrength(s)}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {route === undefined ? (
        <p className="text-data text-fg-secondary">{t("沒有設定比較用的渲染流程。")}</p>
      ) : mode === "grid" ? (
        <Grid key={`${String(round.step)}:${route.route_id}`} route={route} items={items} />
      ) : ab !== null ? (
        <BlindAB key={`${String(round.step)}:${route.route_id}:${String(ab)}`} route={route} items={items} strength={ab} jobId={job.training_id} />
      ) : null}
    </div>
  );
}
