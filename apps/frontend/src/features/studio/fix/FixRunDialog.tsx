// The one compact dialog of a 修正 tool that runs a pipeline: the take is already the input, sensible defaults are
// filled in, and only what the tool really needs is asked (a description to extend with, the final soundtrack, the
// edited video, the second take to compare). Pipeline, components, file hashes and type ids wait under 進階. Starting
// closes the dialog for a tool whose result comes back by itself (a new take, a library item: the take strip shows
// its progress); a tool that hands back files keeps the dialog open with its progress and the files to download.
import { FileUp, LoaderCircle, Play } from "lucide-react";
import { useId, useRef, useState } from "react";
import { Link } from "react-router";
import { componentAvailability, useStableCatalog } from "@/api/catalog";
import { uploadFile } from "@/api/files";
import type { FileRef, StudioTake } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";
import { useCreateRun, useRun } from "@/api/runs";
import { asTypedValue, type RunRequestBody, type WirePipeline, type WireRun, type WireTypedValue } from "@/api/types";
import { componentPath, runPath } from "@/app/paths";
import { ActionButton } from "@/components/common/ActionButton";
import { StatusBadge } from "@/components/common/StatusBadge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Select, Textarea } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/variants";
import { makeLookup, TypedValueInput, validatePipeline } from "@/features/pipelines";
import { t, tServer } from "@/i18n";
import { formatList } from "@/i18n/format";
import { cn } from "@/lib/cn";
import { errorText } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { isRecord } from "@/lib/json";
import { takeNumber } from "../model/takeDownload";
import { useStudio } from "../studioContext";
import { noteMatches, sourceFixLabel, sourceNote, sourceValue, takeValue, toolPipeline, type FixSource, type PipelineTool } from "./tools";
import { useFixRuns } from "./useFixRuns";

export interface FixRunTarget {
  tool: PipelineTool;
  pipeline: WirePipeline;
  source: FixSource;
}

/** The source in one line: 「take 2」 or the library item's name. */
function sourceName(source: FixSource): string {
  return source.kind === "take" ? t("take {number}", { number: takeNumber(source.shot, source.take) }) : source.item.name;
}

/** Names of the inputs a creator fills in (the rest show their own description under 進階). */
function portLabel(name: string): string | null {
  switch (name) {
    case "prompt":
      return t("要接上的畫面描述");
    case "soundtrack":
      return t("定稿聲軌");
    case "video_file":
      return t("修改後的影片");
    case "image_file":
      return t("修改後的圖片（選填）");
    case "take_b":
      return t("要比較的另一個 take");
    default:
      return null;
  }
}

function seconds(take: StudioTake): string {
  const fps = take.asset?.fps;
  const frames = take.asset?.frame_count ?? take.frames;
  return fps && fps.num > 0 ? t("{seconds} 秒", { seconds: ((frames * fps.den) / fps.num).toFixed(2) }) : t("{frames} 幀", { frames });
}

/** Size and length of the source (「1280×720 · 5.04 秒」), when known. */
function sourceFacts(source: FixSource): string | null {
  if (source.kind === "take") return source.take.asset ? `${String(source.take.asset.width)}×${String(source.take.asset.height)} · ${seconds(source.take)}` : null;
  const { width, height, duration_seconds: duration } = source.item;
  const parts = [width !== null && height !== null ? `${String(width)}×${String(height)}` : null, duration !== null ? t("{seconds} 秒", { seconds: duration.toFixed(2) }) : null];
  const known = parts.filter((part) => part !== null);
  return known.length > 0 ? known.join(" · ") : null;
}

/** The file the fix starts from. */
function sourceFile(source: FixSource): FileRef | null {
  return source.kind === "take" ? (source.take.asset?.file ?? null) : source.item.file;
}

/** A media input: a file from the project library, or an upload. */
function MediaField({ id, label, typeId, value, onChange, disabled }: {
  id: string;
  label: string;
  typeId: string;
  value: WireTypedValue | null;
  onChange: (next: WireTypedValue | null) => void;
  disabled: boolean;
}) {
  const { project } = useStudio();
  const kind = typeId.split(".")[1] ?? "";
  const items = (project.library ?? []).filter((item) => item.kind === kind);
  const [uploading, setUploading] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<{ name: string; file: FileRef } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = value && "file" in value ? value.file.sha256 : "";
  return (
    <div className="grid gap-1.5">
      <label htmlFor={`${id}-pick`} className="text-data font-medium text-fg">{label}</label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <Select id={`${id}-pick`} compact disabled={disabled} value={chosen} onChange={(event) => {
            const sha = event.target.value;
            const file = uploaded?.file.sha256 === sha ? uploaded.file : items.find((item) => item.file.sha256 === sha)?.file;
            onChange(file ? { type_id: typeId, file } : null);
          }}>
            <option value="">{items.length > 0 || uploaded ? t("從素材庫選擇…") : t("素材庫沒有這類檔案，請上傳")}</option>
            {uploaded ? <option value={uploaded.file.sha256}>{t("剛上傳：{name}", { name: uploaded.name })}</option> : null}
            {items.map((item) => <option key={item.item_id} value={item.file.sha256}>{item.name}</option>)}
          </Select>
        </div>
        <label htmlFor={`${id}-upload`} className={cn(buttonVariants({ variant: "secondary", size: "sm" }), "cursor-pointer focus-within:outline-2 focus-within:outline-focus", (disabled || uploading !== null) && "cursor-not-allowed opacity-60")}>
          {uploading !== null ? <LoaderCircle aria-hidden className="animate-spin" /> : <FileUp aria-hidden />}
          {uploading !== null ? t("上傳中…") : t("上傳")}
          <input id={`${id}-upload`} type="file" className="sr-only" accept={kind === "audio" || kind === "video" || kind === "image" ? `${kind}/*` : undefined}
            disabled={disabled || uploading !== null}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              setUploading(file.name);
              setError(null);
              uploadFile(file)
                .then((ref) => {
                  setUploaded({ name: file.name, file: ref });
                  onChange({ type_id: typeId, file: ref });
                })
                .catch((cause: unknown) => { setError(errorText(cause)); })
                .finally(() => { setUploading(null); });
            }} />
        </label>
      </div>
      {error !== null ? <p role="alert" className="text-caption text-warning">{error}</p> : null}
    </div>
  );
}

/** What a finished files-tool run hands back: pictures inline, everything else as downloads. */
export function ResultFiles({ run, source, pair }: { run: WireRun; source: FixSource; pair: StudioTake | null }) {
  const first = t("{name} 首格", { name: sourceName(source) });
  const last = t("{name} 尾格", { name: sourceName(source) });
  const names: Record<string, string> = {
    delivery_file: t("美術工作包"),
    manifest_file: t("工作包清單"),
    srt_file: t("字幕檔（SRT）"),
    transcript_file: t("逐字稿"),
    a_first: first,
    a_last: last,
    b_first: pair && source.kind === "take" ? t("take {number} 首格", { number: takeNumber(source.shot, pair) }) : t("另一個 take 首格"),
    b_last: pair && source.kind === "take" ? t("take {number} 尾格", { number: takeNumber(source.shot, pair) }) : t("另一個 take 尾格"),
  };
  const files = Object.entries(run.outputs).flatMap(([key, raw]) => {
    const typed = asTypedValue(raw);
    return typed && "file" in typed ? [{ key, file: typed.file }] : [];
  });
  if (files.length === 0) return <p className="text-data text-fg-secondary">{t("這次執行沒有交付檔案。")}</p>;
  const pictures = files.filter((item) => item.file.media_type.startsWith("image/"));
  const others = files.filter((item) => !item.file.media_type.startsWith("image/"));
  return (
    <div className="grid gap-3">
      {pictures.length > 0 ? (
        <div className="grid grid-cols-2 gap-2">
          {pictures.map(({ key, file }) => (
            <figure key={key} className="grid gap-1">
              <img src={mediaUrl(file.node_id, file.file_id)} alt={names[key] ?? key} className="aspect-video w-full rounded-md border border-line-subtle bg-stage object-contain animate-fade-in" />
              <figcaption className="text-caption text-fg-secondary">{names[key] ?? key}</figcaption>
            </figure>
          ))}
        </div>
      ) : null}
      {others.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {others.map(({ key, file }) => (
            <a key={key} className={buttonVariants({ variant: key === "delivery_file" || key === "srt_file" ? "primary" : "secondary", size: "sm" })}
              href={mediaUrl(file.node_id, file.file_id)} download title={formatBytes(file.size_bytes)}>
              {t("下載{name}", { name: names[key] ?? key })}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FixForm({ target, onClose }: { target: FixRunTarget; onClose: () => void }) {
  const { tool, pipeline, source } = target;
  const { project, runBlockedReason, notify } = useStudio();
  const catalog = useStableCatalog();
  const create = useCreateRun();
  const fixRuns = useFixRuns(project.project_id);
  const formId = useId();
  const inFlightRef = useRef(false);
  const label = sourceFixLabel(source, tool.name());
  const pairs = source.kind === "take"
    ? source.shot.takes.filter((item) => item.take_id !== source.take.take_id && item.state === "succeeded" && item.asset?.complete === true)
    : [];
  // The art package this take was exported with (匯回修改稿 needs its manifest)
  const manifest = tool.id === "art-return"
    ? fixRuns.runs.find((entry) => entry.tool.id === "art-export" && noteMatches(entry.note, source) && entry.run.state === "succeeded")
    : undefined;
  const manifestValue = manifest ? asTypedValue(manifest.run.outputs["manifest_file"]) : null;

  const [inputs, setInputs] = useState<Record<string, WireTypedValue | null>>(() => {
    const initial: Record<string, WireTypedValue | null> = {};
    for (const port of pipeline.inputs) {
      if (port.name === tool.input) initial[port.name] = sourceValue(source, port.type_id);
      else if (port.type_id === "text.prompt.v1" && port.required && source.kind === "take") initial[port.name] = { type_id: port.type_id, value: source.take.prompt ?? source.shot.prompt };
      else if (port.name === tool.pairInput && pairs[0]) initial[port.name] = takeValue(pairs.at(-1) ?? pairs[0], port.type_id);
    }
    return initial;
  });
  const [runName, setRunName] = useState(label);
  const [runId, setRunId] = useState<string | null>(null);
  const started = useRun(runId);
  const merged: Record<string, WireTypedValue | null> = { ...inputs, ...(manifestValue && !inputs["manifest_file"] ? { manifest_file: manifestValue } : {}) };
  const set = (name: string, value: WireTypedValue | null) => { setInputs((old) => ({ ...old, [name]: value })); };

  const lookup = makeLookup(catalog.data);
  const wiring = validatePipeline(pipeline, lookup).find((issue) => issue.severity === "error")?.message ?? null;
  // A stopped on-demand component is loaded by the run itself: it does not block, it only takes longer the first time
  const availability = pipeline.steps.map((step) => {
    const descriptor = lookup(step.node_id, step.component_id);
    return { step, name: descriptor?.label ?? step.component_id, state: descriptor ? componentAvailability(descriptor) : "unavailable" };
  });
  const unready = availability.filter((item) => item.state === "unavailable");
  const onUse = availability.filter((item) => item.state === "on_use");
  const shown = new Set([...(tool.shown ?? []), ...(tool.pairInput !== undefined ? [tool.pairInput] : []), ...pipeline.inputs.filter((port) => port.required && port.name !== tool.input && port.name !== "manifest_file").map((port) => port.name)]);
  const missing = pipeline.inputs.find((port) => port.required && !merged[port.name]);
  const missingText = !missing ? null
    : missing.name === "manifest_file" ? t("請先用「在 Krita 修稿」匯出這個 take 的工作包，再匯回修改稿。")
    : missing.name === tool.input ? (source.kind === "take" ? t("這個 take 還沒有完整的影片。") : t("這個素材不能用在這項修正。"))
    : t("請先填好「{name}」。", { name: portLabel(missing.name) ?? missing.name });
  const artReturnEmpty = tool.id === "art-return" && !merged["video_file"] && !merged["image_file"] ? t("請選擇修改後的影片或圖片。") : null;
  const block = catalog.isPending ? t("正在讀取元件狀態…")
    : unready[0] ? t("「{name}」元件還沒啟動。", { name: unready[0].name })
    : wiring ?? missingText ?? artReturnEmpty ?? runBlockedReason;
  const busy = create.isPending;
  const filesRun = runId !== null ? (started.data ?? null) : null;

  const submit = () => {
    if ((block ?? "") !== "" || inFlightRef.current || runId !== null) return;
    inFlightRef.current = true;
    const body: RunRequestBody = {
      pipeline: toolPipeline(tool, pipeline, source),
      inputs: Object.fromEntries(Object.entries(merged).flatMap(([key, value]) => (value ? [[key, value]] : []))),
      label: runName.trim() || label,
      origin: {
        ...(source.kind === "take" ? { source_run_id: source.take.run_id } : source.item.source?.kind === "run_output" ? { source_run_id: source.item.source.run_id } : {}),
        note: sourceNote(project.project_id, source, tool.id),
      },
    };
    create.mutate(body, {
      onSuccess: (run) => {
        if (tool.result === "files") {
          setRunId(run.run_id);
          return;
        }
        notify({
          tone: "info",
          title: t("已開始{tool}（{source}）", { tool: tool.name(), source: sourceName(source) }),
          detail: tool.result === "take" && source.kind === "take" ? t("完成後會成為「{label}」，出現在 take 列。", { label }) : t("完成後會加入素材庫。"),
        });
        onClose();
      },
      onSettled: () => { inFlightRef.current = false; },
    });
  };

  const pairPort = tool.pairInput !== undefined ? pipeline.inputs.find((port) => port.name === tool.pairInput) : undefined;
  const pairValue = pairPort ? merged[pairPort.name] : null;
  const pairAsset = pairValue && "value" in pairValue && isRecord(pairValue.value) ? pairValue.value["asset_id"] : undefined;
  const pairChoice = pairs.find((item) => pairAsset !== undefined && item.asset?.asset_id === pairAsset);
  const advancedPorts = pipeline.inputs.filter((port) => port.name !== tool.input && !shown.has(port.name));

  return (
    <>
      <DialogBody className="grid gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line-subtle bg-sunken px-3 py-2 text-data">
          <span className="font-medium text-fg">{t("輸入")}</span>
          <span className="min-w-0 truncate text-fg-secondary">{sourceName(source)}</span>
          {sourceFacts(source) !== null ? <span className="machine text-fg-tertiary">{sourceFacts(source)}</span> : null}
        </div>

        {pairPort ? (
          <label className="grid gap-1.5">
            <span className="text-data font-medium text-fg">{portLabel(pairPort.name)}</span>
            <Select compact disabled={busy || runId !== null} value={pairChoice?.take_id ?? ""} onChange={(event) => {
              const other = pairs.find((item) => item.take_id === event.target.value);
              set(pairPort.name, other ? takeValue(other, pairPort.type_id) : null);
            }}>
              <option value="">{pairs.length > 0 ? t("選擇 take…") : t("這個鏡頭沒有其他完成的 take")}</option>
              {source.kind === "take" ? pairs.map((item) => <option key={item.take_id} value={item.take_id}>{t("take {number}", { number: takeNumber(source.shot, item) })}</option>) : null}
            </Select>
          </label>
        ) : null}

        {pipeline.inputs.filter((port) => shown.has(port.name) && port.name !== tool.pairInput).map((port) => {
          const name = portLabel(port.name) ?? (tServer(port.description) || port.name);
          if (port.type_id === "text.prompt.v1") {
            const value = merged[port.name];
            return (
              <label key={port.name} className="grid gap-1.5">
                <span className="text-data font-medium text-fg">{name}</span>
                <Textarea rows={4} disabled={busy} value={value && "value" in value && typeof value.value === "string" ? value.value : ""}
                  onChange={(event) => { set(port.name, event.target.value.trim() ? { type_id: port.type_id, value: event.target.value } : null); }} />
              </label>
            );
          }
          if (/^media\.(audio|video|image)\.v1$/.test(port.type_id)) {
            return <MediaField key={port.name} id={`${formId}-${port.name}`} label={name} typeId={port.type_id} value={merged[port.name] ?? null} disabled={busy} onChange={(value) => { set(port.name, value); }} />;
          }
          return (
            <div key={port.name} className="grid gap-1.5">
              <span className="text-data font-medium text-fg">{name}</span>
              <TypedValueInput id={`${formId}-${port.name}`} label={name} typeId={port.type_id} transport={port.transport} required={port.required} value={merged[port.name] ?? null} onChange={(value) => { set(port.name, value); }} disabled={busy} />
            </div>
          );
        })}

        {tool.id === "art-return" && manifest ? <p className="text-caption text-fg-secondary">{source.kind === "take" ? t("會對照這個 take 最近一次匯出的工作包。") : t("會對照這個素材最近一次匯出的工作包。")}</p> : null}

        {onUse.length > 0 && unready.length === 0 ? (
          <p className="text-caption text-fg-secondary">{t("首次使用會先載入「{name}」的模型，會多等一些時間。", { name: formatList(onUse.map((item) => item.name)) })}</p>
        ) : null}
        {unready.length > 0 ? (
          <Callout tone="warning" title={t("需要先啟動元件")}>
            <ul className="grid gap-1">
              {unready.map(({ step, name }) => (
                <li key={step.step_id}><Link className="underline" to={componentPath(step.node_id, step.component_id)}>{t("到元件頁啟動「{name}」", { name })}</Link></li>
              ))}
            </ul>
          </Callout>
        ) : null}

        {filesRun ? (
          <section className="grid gap-2 rounded-lg border border-line-subtle p-3" aria-live="polite">
            <div className="flex items-center gap-2 text-data">
              {filesRun.state === "running" ? <LoaderCircle aria-hidden className="size-4 animate-spin text-brand-cyan" /> : null}
              <span className="font-medium">{filesRun.state === "running" ? t("執行中…") : filesRun.state === "succeeded" ? t("完成") : t("沒有完成")}</span>
              <StatusBadge kind="run" value={filesRun.state} />
            </div>
            {filesRun.state === "succeeded" ? <ResultFiles run={filesRun} source={source} pair={pairChoice ?? null} /> : null}
            {filesRun.error ? <p role="alert" className="text-caption text-warning">{errorText(filesRun.error)}</p> : null}
          </section>
        ) : null}

        {create.isError ? <p role="alert" className="text-data text-warning">{errorText(create.error)}</p> : null}

        <details className="group rounded-lg border border-line-subtle px-3 py-2 text-data">
          <summary className="cursor-pointer text-fg-secondary select-none hover:text-fg">{t("進階")}</summary>
          <div className="mt-3 grid gap-3">
            <label className="grid gap-1">
              <span className="text-caption text-fg-secondary">{t("執行名稱")}</span>
              <Input value={runName} disabled={busy || runId !== null} onChange={(event) => { setRunName(event.target.value); }} />
            </label>
            {advancedPorts.map((port) => (
              <div key={port.name} className="grid gap-1">
                <span className="text-caption text-fg-secondary">{tServer(port.description) || port.name} <code className="machine text-fg-tertiary">{port.name} · {port.type_id}</code></span>
                {port.name === "manifest_file" && manifestValue && !inputs["manifest_file"]
                  ? <p className="text-caption text-fg-tertiary">{t("已自動帶入最近一次匯出的工作包清單")}</p>
                  : <TypedValueInput id={`${formId}-adv-${port.name}`} label={port.name} typeId={port.type_id} transport={port.transport} required={port.required} value={inputs[port.name] ?? null} onChange={(value) => { set(port.name, value); }} disabled={busy} />}
              </div>
            ))}
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-caption">
              <dt className="text-fg-tertiary">{t("流程")}</dt>
              <dd className="machine break-all text-fg-secondary">{pipeline.pipeline_id}</dd>
              <dt className="text-fg-tertiary">{t("步驟")}</dt>
              <dd className="machine break-all text-fg-secondary">{formatList(pipeline.steps.map((step) => `${step.step_id} → ${step.node_id}/${step.component_id}`), { type: "unit" })}</dd>
              <dt className="text-fg-tertiary">{t("輸入連接埠")}</dt>
              <dd className="machine break-all text-fg-secondary">{tool.input || "—"}</dd>
              {sourceFile(source) ? (
                <>
                  <dt className="text-fg-tertiary">SHA-256</dt>
                  <dd className="machine break-all text-fg-secondary">{sourceFile(source)?.sha256}</dd>
                  <dt className="text-fg-tertiary">file_id</dt>
                  <dd className="machine break-all text-fg-secondary">{sourceFile(source)?.file_id}</dd>
                </>
              ) : null}
              {runId !== null ? (
                <>
                  <dt className="text-fg-tertiary">{t("執行紀錄")}</dt>
                  <dd><Link className="machine break-all text-action-fg underline" to={runPath(runId)}>{runId}</Link></dd>
                </>
              ) : null}
            </dl>
          </div>
        </details>
      </DialogBody>
      <DialogFooter>
        <Button variant="quiet" onClick={onClose}>{runId !== null ? t("關閉") : t("取消")}</Button>
        {runId === null ? (
          <ActionButton variant="primary" icon={<Play aria-hidden />} pending={busy} disabledReason={busy ? null : block} onClick={submit}>
            {t("開始{tool}", { tool: tool.name() })}
          </ActionButton>
        ) : null}
      </DialogFooter>
    </>
  );
}

export function FixRunDialog({ target, onClose }: { target: FixRunTarget | null; onClose: () => void }) {
  const resultText = !target ? "" : target.tool.result === "take" && target.source.kind === "take"
    ? t("完成後成為這個鏡頭的新 take：{label}", { label: sourceFixLabel(target.source, target.tool.name()) })
    : target.tool.result === "files" ? t("完成後在這裡下載結果。") : t("完成後加入專案素材庫。");
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-xl" onKeyDown={(event) => { event.stopPropagation(); }}>
        <DialogHeader>
          <DialogTitle>{target ? target.tool.name() : ""}</DialogTitle>
          <DialogDescription>{target ? t("{description}。{resultText}", { description: target.tool.description(), resultText }) : ""}</DialogDescription>
        </DialogHeader>
        {target ? <FixForm key={`${target.tool.id}/${target.source.kind === "take" ? target.source.take.take_id : target.source.item.item_id}`} target={target} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}
