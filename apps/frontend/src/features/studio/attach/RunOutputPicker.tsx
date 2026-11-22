// The picker the 「附加歷史輸出」 and 「採用現有影片」 dialogs share: a searchable list of finished videos (poster frame,
// shot or run title, project, length, size, when it was made, what made it, whether this shot already has it) with
// the chosen one playing beside it. Names only: a run's id stays in the row's tooltip and behind 「複製執行紀錄 ID」.
// The list works from the keyboard as a combobox: typing filters, ↑/↓/Home/End/PageUp/PageDown move the choice.
import { Check, Copy, ImageOff, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { Asset, StudioShot } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { useStudioProjects } from "@/api/studioProjects";
import type { WireRun } from "@/api/types";
import { AssetVideo } from "@/components/common/AssetMedia";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { t } from "@/i18n";
import { formatDateTime, formatNumber, formatRelativeTime } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { writeClipboard } from "@/lib/dom";
import { firstFrameCount } from "@/lib/json";
import { workKinds } from "../components/projectHistoryState";
import { TransportBar } from "../components/monitor/TransportBar";
import { routeName } from "../model/routes";
import { useVideoClock } from "../hooks/useVideoClock";
import { useStudio } from "../studioContext";

export interface PickerRow {
  /** `${run_id}/${output key}`: the selection value (never shown). */
  id: string;
  run: WireRun;
  key: string;
  asset: Asset;
}

interface RowText {
  title: string;
  /** Which of the run's videos (「輸出 2」) when it published several; null for a run with one video. */
  output: string | null;
  /** Project (and for another project's run nothing more): the second line. */
  context: string;
  /** What made it: the Studio work kind, or the tool's name. */
  route: string;
  seconds: number | null;
  size: string;
  created: string;
  relative: string;
  archived: boolean;
  search: string;
}

function lengthSeconds(asset: Asset): number | null {
  if (!asset.fps || asset.fps.num <= 0 || asset.fps.den <= 0) return null;
  return asset.frame_count / (asset.fps.num / asset.fps.den);
}

function describe(row: PickerRow, index: number, count: number, now: number, shots: ReadonlyMap<string, string>, projects: ReadonlyMap<string, string>, currentProject: string): RowText {
  const { run, asset } = row;
  const work = run.studio_work;
  const runName = (run.request.label ?? "") || run.request.pipeline.label || t("未命名執行");
  const shotTitle = work?.project_id === currentProject && work.shot_id !== undefined ? shots.get(work.shot_id) : undefined;
  const base = shotTitle !== undefined ? shotTitle || t("未命名鏡頭") : runName;
  const title = base;
  const output = count > 1 ? t("輸出 {n}", { n: index + 1 }) : null;
  const project = work ? projects.get(work.project_id) ?? "" : "";
  const context = work ? project || t("其他專案") : t("工具執行");
  // A one-off tool run is often labelled after its tool: then the tool's name would only repeat the title
  const tool = routeName(run.request.pipeline.label || run.request.pipeline.pipeline_id).name;
  const repeats = tool.slice(0, 16) === runName.slice(0, 16);
  const route = work ? workKinds[work.operation_kind] : repeats ? "" : tool;
  const seconds = lengthSeconds(asset);
  const size = `${String(asset.width)}×${String(asset.height)}`;
  const createdMs = Date.parse(run.created_at);
  const created = formatDateTime(run.created_at);
  const relative = Number.isNaN(createdMs) ? created : formatRelativeTime(createdMs, now);
  const archived = run.archived_at !== undefined && run.archived_at !== null;
  return { title, output, context, route, seconds, size, created, relative, archived, search: [title, output ?? "", runName, context, route, size, created].join("\n").toLocaleLowerCase() };
}

/** The video's poster frame, loaded only once its row scrolls into view (a long list never opens every file at once). */
function PosterFrame({ asset }: { asset: Asset }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    }, { rootMargin: "120px" });
    observer.observe(element);
    return () => { observer.disconnect(); };
  }, [seen]);
  return (
    <span ref={ref} aria-hidden className="grid aspect-video w-24 shrink-0 place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage">
      {failed ? (
        <ImageOff className="size-4 text-fg-disabled" />
      ) : seen ? (
        <AssetVideo
          src={`${mediaUrl(asset.file.node_id, asset.file.file_id)}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          onError={() => { setFailed(true); }}
          className="size-full object-cover"
        />
      ) : null}
    </span>
  );
}

function Meta({ text }: { text: RowText }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption text-fg-tertiary">
      {text.output !== null ? <span className="text-fg-secondary">{text.output}</span> : null}
      {text.seconds !== null ? <span className="machine">{t("{seconds} 秒", { seconds: formatNumber(text.seconds, { maximumFractionDigits: 1 }) })}</span> : null}
      <span className="machine">{text.size}</span>
      <span title={text.created}>{text.relative}</span>
    </span>
  );
}

/** The chosen video with the Studio's own transport (scrub, frame steps, play) under the picture. */
function Preview({ row, text }: { row: PickerRow; text: RowText }) {
  const ref = useRef<HTMLVideoElement>(null);
  const src = mediaUrl(row.asset.file.node_id, row.asset.file.file_id);
  const fps = row.asset.fps && row.asset.fps.den > 0 ? row.asset.fps.num / row.asset.fps.den : 24;
  const clock = useVideoClock(ref, src, fps);
  const total = firstFrameCount([row.asset.frame_count, Math.round(clock.duration * fps)], 0);
  const frame = Math.min(clock.frame, Math.max(0, total - 1));
  const [copied, setCopied] = useState(false);
  const seek = (next: number) => {
    const video = ref.current;
    if (!video) return;
    video.pause();
    video.currentTime = Math.max(0, Math.min(total - 1, next)) / fps;
  };
  const toggle = () => {
    const video = ref.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => undefined);
    else video.pause();
  };
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="relative overflow-hidden rounded-lg border border-line-subtle bg-stage" style={{ aspectRatio: `${String(row.asset.width)} / ${String(row.asset.height)}` }}>
        <AssetVideo
          ref={ref}
          src={src}
          preload="metadata"
          playsInline
          aria-label={t("來源影片預覽：{name}", { name: text.title })}
          className="absolute inset-0 size-full object-contain animate-fade-in"
        />
      </div>
      <TransportBar
        frame={frame}
        total={total}
        fps={fps}
        playing={clock.playing}
        labels={{ group: t("預覽播放控制"), scrub: t("預覽播放位置"), play: t("播放") }}
        onSeek={seek}
        onToggle={toggle}
        onStep={(frames) => { seek(frame + frames); }}
      />
      <div className="min-w-0 space-y-1">
        <p className="text-data font-medium break-words text-fg">{text.title}</p>
        <p className="text-caption break-words text-fg-secondary">{[text.context, text.route].filter(Boolean).join(" · ")}</p>
        <Meta text={text} />
      </div>
      <Button
        variant="quiet"
        size="sm"
        className="self-start"
        icon={copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        title={row.run.run_id}
        onClick={() => { void writeClipboard(row.run.run_id).then((ok) => { setCopied(ok); }); }}
      >
        {copied ? t("已複製") : t("複製執行紀錄 ID")}
      </Button>
    </div>
  );
}

const PAGE = 5;

export interface RunOutputPickerProps {
  shot: StudioShot;
  rows: readonly PickerRow[];
  selection: string;
  onSelect: (id: string) => void;
  disabled: boolean;
  /** Label of the list (and of its search field). */
  label: string;
  /** The badge for a video this shot already has (「已附加」, 「已在候選」). */
  takenLabel: string;
  /** Shown when the loaded runs hold no video at all. */
  emptyText: string;
  loading: boolean;
  error: ReactNode;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  /** Under the preview: the dialog's own choices and its action button. */
  children?: ReactNode;
}

export function RunOutputPicker({ shot, rows, selection, onSelect, disabled, label, takenLabel, emptyText, loading, error, hasMore, loadingMore, onLoadMore, children }: RunOutputPickerProps) {
  const { project } = useStudio();
  const projects = useStudioProjects();
  const [now] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const texts = useMemo(() => {
    const shots = new Map(project.shots.map((item) => [item.shot_id, item.title]));
    const names = new Map((projects.data?.items ?? []).map((item) => [item.project_id, item.title || t("未命名專案")]));
    names.set(project.project_id, project.title || t("未命名專案"));
    const perRun = new Map<string, PickerRow[]>();
    for (const row of rows) perRun.set(row.run.run_id, [...(perRun.get(row.run.run_id) ?? []), row]);
    return new Map(rows.map((row) => {
      const siblings = perRun.get(row.run.run_id) ?? [row];
      return [row.id, describe(row, siblings.indexOf(row), siblings.length, now, shots, names, project.project_id)];
    }));
  }, [rows, project, projects.data, now]);

  const needle = query.trim().toLocaleLowerCase();
  const shown = needle ? rows.filter((row) => texts.get(row.id)?.search.includes(needle) === true) : rows;
  const taken = (row: PickerRow) => shot.takes.some((take) => take.run_id === row.run.run_id && take.output_key === row.key);
  const optionId = (row: PickerRow) => `${listId}-${String(rows.indexOf(row))}`;
  const active = shown.find((row) => row.id === selection);
  const selected = rows.find((row) => row.id === selection);
  const selectedText = selected ? texts.get(selected.id) : undefined;

  // The chosen row stays in view while the arrow keys move it
  useEffect(() => {
    if (!active) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  });

  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled || shown.length === 0) return;
    const at = active ? shown.indexOf(active) : -1;
    const last = shown.length - 1;
    const target = ({
      ArrowDown: Math.min(last, at + 1),
      ArrowUp: at < 0 ? 0 : Math.max(0, at - 1),
      Home: 0,
      End: last,
      PageDown: Math.min(last, Math.max(0, at) + PAGE),
      PageUp: Math.max(0, at - PAGE),
    } as Record<string, number | undefined>)[event.key];
    if (target === undefined) return;
    // Home/End stay with the text field's caret while it has text
    if ((event.key === "Home" || event.key === "End") && event.currentTarget instanceof HTMLInputElement && query !== "") return;
    event.preventDefault();
    const next = shown[target];
    if (next) onSelect(next.id);
  };

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,19rem)]">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="relative">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
          <Input
            compact
            type="search"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(active) : undefined}
            aria-label={t("搜尋{label}", { label })}
            placeholder={t("搜尋名稱、專案、尺寸或日期")}
            value={query}
            onChange={(event) => { setQuery(event.target.value); }}
            onKeyDown={onKey}
            className="pl-8"
          />
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-busy={loading || undefined}
          aria-disabled={disabled || undefined}
          onKeyDown={onKey}
          className="max-h-[min(24rem,50dvh)] min-h-24 overflow-y-auto overscroll-contain rounded-lg border border-line-subtle bg-sunken/40 p-1"
        >
          {shown.map((row) => {
            const text = texts.get(row.id);
            if (!text) return null;
            const isSelected = row.id === selection;
            const isTaken = taken(row);
            return (
              <div
                key={row.id}
                id={optionId(row)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={disabled || undefined}
                title={t("執行紀錄 ID：{id}", { id: row.run.run_id })}
                tabIndex={-1}
                onClick={() => { if (!disabled) onSelect(row.id); }}
                onKeyDown={(event) => {
                  if ((event.key === "Enter" || event.key === " ") && !disabled) {
                    event.preventDefault();
                    onSelect(row.id);
                  }
                }}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-md border p-2 transition-colors duration-(--duration-fast)",
                  isSelected ? "border-brand-blue/60 bg-brand-gradient-soft" : "border-transparent hover:border-line-subtle hover:bg-raised/60",
                  disabled && "cursor-not-allowed",
                )}
              >
                <PosterFrame asset={row.asset} />
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block truncate text-data text-fg">{text.title}</span>
                  <span className="block truncate text-caption text-fg-secondary">{[text.context, text.route].filter(Boolean).join(" · ")}</span>
                  <Meta text={text} />
                </span>
                <span className="flex shrink-0 flex-col items-end gap-1">
                  {isTaken ? <Badge tone="info">{takenLabel}</Badge> : null}
                  {text.archived ? <Badge>{t("已封存")}</Badge> : null}
                  {isSelected ? <Check aria-hidden className="size-4 text-brand-cyan" /> : null}
                </span>
              </div>
            );
          })}
          {error !== null && error !== false && error !== undefined ? (
            <p role="alert" className="px-2 py-3 text-caption text-danger">{error}</p>
          ) : loading ? (
            <p role="status" className="px-2 py-3 text-caption text-fg-secondary">{t("讀取中…")}</p>
          ) : rows.length === 0 ? (
            <p role="status" className="px-2 py-3 text-caption text-fg-secondary">{emptyText}</p>
          ) : shown.length === 0 ? (
            <p role="status" className="px-2 py-3 text-caption text-fg-secondary">{t("沒有符合「{query}」的影片", { query: query.trim() })}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-caption text-fg-tertiary" aria-live="polite">
            {needle ? t("{shown} / {count} 部影片", { shown: shown.length, count: rows.length }) : t("{count} 部影片", { count: rows.length })}
          </span>
          {hasMore ? (
            <Button variant="secondary" size="sm" pending={loadingMore} onClick={onLoadMore}>
              {t("讀取較早的執行紀錄")}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        {selected && selectedText ? (
          <Preview key={selected.id} row={selected} text={selectedText} />
        ) : (
          <div className="grid aspect-video place-items-center rounded-lg border border-dashed border-line-subtle bg-sunken/40 p-4 text-center text-caption text-fg-tertiary">
            {t("從左側選一部影片，這裡會播放預覽。")}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
