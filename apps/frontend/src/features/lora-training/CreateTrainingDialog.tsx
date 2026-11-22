// 新增訓練：影片（拖放／選檔上傳，或從主控機器挑選）＋每支影片的用途（訓練／留出／只比較）＋訓練方向。其餘都有預設：
// 進階裡可以改比較的強度、比較用的渲染流程、提早比較與先檢查資料。建立後對話框自動關閉並開啟工作區。上傳與建立都不自動重送。
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, HardDrive, LoaderCircle, Plus, Trash2, Wand2 } from "lucide-react";
import { useId, useMemo, useRef, useState, type DragEvent } from "react";
import { uploadFile } from "@/api/files";
import type { FileRef, LoraTrainingOptions, LoraTrainingRoute } from "@/api/generated/contracts";
import { usePipelines } from "@/api/pipelines";
import { useCatalog } from "@/api/catalog";
import { Disclosure } from "@/components/common/Disclosure";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Button } from "@/components/ui/button";
import { Input, Switch, Textarea } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CHOICE_BASE, CHOICE_IDLE, CHOICE_SELECTED } from "@/components/ui/look";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { createTraining, trainingKeys } from "./api";
import { DIRECTION_SUGGESTIONS, ROLE_HINT, ROLE_LABEL, type SourceRole } from "./model";
import { ServerPicker, type PickedFile } from "./ServerPicker";

interface VideoRow {
  key: string;
  name: string;
  size: number;
  role: SourceRole;
  file: FileRef | null;
  state: "uploading" | "ready" | "error";
}

const STRENGTH_CHOICES = [0.25, 0.5, 0.75, 1, 1.25] as const;
const ROLES: readonly SourceRole[] = ["train", "heldout", "eval_only"];
const MAX_ROUTES = 2;
let rowSeq = 0;

function RoleChoice({ value, onChange, name }: { value: SourceRole; onChange: (role: SourceRole) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label={t("{name} 的用途", { name })} className="flex flex-wrap gap-1">
      {ROLES.map((role) => (
        <button
          key={role}
          type="button"
          role="radio"
          aria-checked={value === role}
          title={ROLE_HINT[role]}
          onClick={() => { onChange(role); }}
          className={cn(CHOICE_BASE, "min-h-8 rounded-md px-2.5 text-caption", value === role ? CHOICE_SELECTED : CHOICE_IDLE)}
        >
          {ROLE_LABEL[role]}
        </button>
      ))}
    </div>
  );
}

function useRoutes() {
  const pipelines = usePipelines();
  const ditKeys = useCatalog((catalog) =>
    new Set(catalog.nodes.flatMap((node) => node.components.filter((c) => c.provider_id === "h3.dit").map((c) => `${node.node_id}/${c.component_id}`))),
  );
  return useMemo(() => {
    const keys = ditKeys.data;
    if (!keys) return [];
    return (pipelines.data?.items ?? []).filter(
      (p) => "asset" in p.outputs && p.steps.filter((s) => keys.has(`${s.node_id}/${s.component_id}`)).length === 1,
    );
  }, [pipelines.data, ditKeys.data]);
}

export function CreateTrainingDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (id: string) => void }) {
  const id = useId();
  const client = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [direction, setDirection] = useState("");
  const [name, setName] = useState("");
  const [strengths, setStrengths] = useState<number[]>([0.25, 0.5, 0.75, 1]);
  const [earlyCompare, setEarlyCompare] = useState(true);
  const [reviewFirst, setReviewFirst] = useState(false);
  const [routeIds, setRouteIds] = useState<string[] | null>(null);
  const [picking, setPicking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const routes = useRoutes();
  const chosenRoutes = routeIds ?? routes.slice(0, 1).map((r) => r.pipeline_id);

  const uploading = videos.some((v) => v.state === "uploading");
  const trainable = videos.some((v) => v.role === "train" && v.state === "ready");
  const problem = !trainable ? t("至少要有一支「訓練」影片上傳完成") : direction.trim() === "" ? t("寫下訓練方向") : uploading ? t("等影片上傳完") : null;

  const reset = () => {
    setVideos([]);
    setDirection("");
    setName("");
    setStrengths([0.25, 0.5, 0.75, 1]);
    setEarlyCompare(true);
    setReviewFirst(false);
    setRouteIds(null);
    setPicking(false);
    setError(null);
  };
  const close = (next: boolean) => {
    if (saving) return;
    if (!next) reset();
    onOpenChange(next);
  };
  const patch = (key: string, change: Partial<VideoRow>) => {
    setVideos((rows) => rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  };
  const addFiles = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("video/")) continue;
      rowSeq += 1;
      const key = `u${String(rowSeq)}`;
      setVideos((rows) => [...rows, { key, name: file.name, size: file.size, role: "train", file: null, state: "uploading" }]);
      uploadFile(file).then(
        (ref) => { patch(key, { file: ref, state: "ready" }); },
        () => { patch(key, { state: "error" }); },
      );
    }
  };
  const addPicked = (picked: PickedFile[]) => {
    setPicking(false);
    setVideos((rows) => [
      ...rows,
      ...picked.map((p) => {
        rowSeq += 1;
        return { key: `s${String(rowSeq)}`, name: p.name, size: p.size, role: "train" as const, file: p.file, state: "ready" as const };
      }),
    ]);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };
  const submit = async () => {
    if (problem !== null) return;
    setSaving(true);
    setError(null);
    const evalRoutes: LoraTrainingRoute[] = chosenRoutes.map((pipelineId, i) => ({
      route_id: `r${String(i + 1)}`,
      pipeline_id: pipelineId,
      label: routes.find((r) => r.pipeline_id === pipelineId)?.label ?? pipelineId,
    }));
    const options: LoraTrainingOptions = {
      strengths: [0, ...strengths],
      early_compare_step: earlyCompare ? 150 : null,
      review_before_training: reviewFirst,
      eval_routes: evalRoutes,
    };
    try {
      const job = await createTraining({
        direction: direction.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        sources: videos.flatMap((v) => (v.state === "ready" && v.file !== null ? [{ file: v.file, label: v.name, role: v.role }] : [])),
        options,
      });
      await client.invalidateQueries({ queryKey: trainingKeys.list() });
      reset();
      onCreated(job.training_id);
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent wide closeDisabled={saving}>
        <DialogHeader>
          <DialogTitle>{t("新增 LoRA 訓練")}</DialogTitle>
          <DialogDescription>{t("放進影片、寫下想學的方向就好；切片、自動反推、訓練與強度比較都會自動完成。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-5">
          <section aria-labelledby={`${id}-videos`} className="grid gap-2">
            <h3 id={`${id}-videos`} className="text-body font-semibold text-fg">{t("影片")}</h3>
            <div /* eslint-disable-line jsx-a11y-x/no-static-element-interactions -- This drop target complements the keyboard-accessible file pickers inside it. */
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => { setDragging(false); }}
              onDrop={onDrop}
              className={cn(
                "grid place-items-center gap-2 rounded-xl border border-dashed p-5 text-center transition-[border-color,background-color] duration-(--duration-fast)",
                dragging ? "border-brand-cyan bg-brand-gradient-soft" : "border-line-strong bg-sunken/40",
              )}
            >
              <FileUp aria-hidden className="size-6 text-brand-cyan" />
              <p className="text-data text-fg-secondary">{t("把影片拖到這裡，或")}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button icon={<Plus aria-hidden />} onClick={() => inputRef.current?.click()}>{t("選擇影片")}</Button>
                <Button icon={<HardDrive aria-hidden />} onClick={() => { setPicking((v) => !v); }} aria-expanded={picking}>{t("從主控機器選擇")}</Button>
              </div>
              <input ref={inputRef} type="file" accept="video/*" multiple className="sr-only" aria-label={t("選擇影片")} onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
            </div>
            {picking ? <ServerPicker onPicked={addPicked} onClose={() => { setPicking(false); }} /> : null}
            {videos.length > 0 ? (
              <ul className="grid gap-2" aria-label={t("加入的影片")}>
                {videos.map((video) => (
                  <li key={video.key} className="grid gap-2 rounded-lg border border-line-subtle bg-canvas/60 p-2.5 animate-rise-in sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                    <span className="flex min-w-0 items-center gap-2">
                      {video.state === "uploading" ? <LoaderCircle aria-label={t("上傳中")} className="size-4 shrink-0 animate-spin text-brand-cyan" /> : null}
                      <span className="min-w-0 truncate text-data text-fg" title={video.name}>{video.name}</span>
                      <span className="machine shrink-0 text-caption text-fg-tertiary">{formatBytes(video.size)}</span>
                      {video.state === "error" ? <span className="shrink-0 text-caption text-danger">{t("上傳失敗")}</span> : null}
                    </span>
                    <RoleChoice name={video.name} value={video.role} onChange={(role) => { patch(video.key, { role }); }} />
                    <Button variant="quiet" size="icon-sm" aria-label={t("移除 {name}", { name: video.name })} onClick={() => { setVideos((rows) => rows.filter((row) => row.key !== video.key)); }}>
                      <Trash2 aria-hidden />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
          <section aria-labelledby={`${id}-direction`} className="grid gap-2">
            <label id={`${id}-direction`} htmlFor={`${id}-direction-input`} className="text-body font-semibold text-fg">{t("想學什麼（方向）")}</label>
            <Textarea id={`${id}-direction-input`} value={direction} maxLength={500} onChange={(event) => { setDirection(event.target.value); }} placeholder={t("例如：動漫戰鬥的運鏡與打擊感")} className="min-h-20" />
            <div className="flex flex-wrap gap-1.5" aria-label={t("方向範例")}>
              {DIRECTION_SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => { setDirection(s); }} className={cn(CHOICE_BASE, CHOICE_IDLE, "inline-flex min-h-8 items-center gap-1.5 rounded-full px-3 text-caption")}>
                  <Wand2 aria-hidden className="size-3.5 text-brand-cyan" />
                  {s}
                </button>
              ))}
            </div>
          </section>
          <section className="grid gap-2">
            <label htmlFor={`${id}-name`} className="text-body font-semibold text-fg">{t("名稱（選填）")}</label>
            <Input id={`${id}-name`} value={name} maxLength={80} onChange={(event) => { setName(event.target.value); }} placeholder={t("沒填就用方向當名稱")} />
          </section>
          <Disclosure summary={t("進階：比較方式")}>
            <div className="grid gap-4 pt-2">
              <div className="grid gap-2">
                <span className="text-data font-medium text-fg">{t("比較的 LoRA 強度（一定包含「不用 LoRA」）")}</span>
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("比較的 LoRA 強度")}>
                  {STRENGTH_CHOICES.map((s) => {
                    const on = strengths.includes(s);
                    return (
                      <button key={s} type="button" aria-pressed={on} onClick={() => { setStrengths((list) => (on ? list.filter((x) => x !== s) : [...list, s].sort((a, b) => a - b))); }}
                        className={cn(CHOICE_BASE, "machine min-h-9 rounded-md px-3 text-data", on ? CHOICE_SELECTED : CHOICE_IDLE)}>
                        {`×${String(s)}`}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid gap-2">
                <span className="text-data font-medium text-fg">{t("比較用的渲染流程（最多 2 條）")}</span>
                {routes.length === 0 ? (
                  <p className="text-caption text-fg-tertiary">{t("沒有含 H3 DiT 且輸出成品影片的元件組合；比較會被略過。")}</p>
                ) : (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("比較用的渲染流程")}>
                    {routes.map((route) => {
                      const on = chosenRoutes.includes(route.pipeline_id);
                      return (
                        <button key={route.pipeline_id} type="button" aria-pressed={on} title={route.pipeline_id}
                          disabled={!on && chosenRoutes.length >= MAX_ROUTES}
                          onClick={() => { setRouteIds(on ? chosenRoutes.filter((x) => x !== route.pipeline_id) : [...chosenRoutes, route.pipeline_id]); }}
                          className={cn(CHOICE_BASE, "max-w-full min-h-9 truncate rounded-md px-3 text-left text-data disabled:opacity-50", on ? CHOICE_SELECTED : CHOICE_IDLE)}>
                          {route.label || route.pipeline_id}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <Switch id={`${id}-early`} checked={earlyCompare} onChange={(event) => { setEarlyCompare(event.target.checked); }} label={t("第 150 步先比較一次")} description={t("早一點看出有沒有幫助；不好的話可以直接停止訓練")} />
              <Switch id={`${id}-review`} checked={reviewFirst} onChange={(event) => { setReviewFirst(event.target.checked); }} label={t("訓練前先讓我檢查資料")} description={t("關閉時全自動：挑好資料就直接開始訓練")} />
            </div>
          </Disclosure>
          {error !== null ? <ErrorCallout error={error} write title={t("無法建立訓練")} /> : null}
        </DialogBody>
        <DialogFooter>
          {problem !== null ? <span className="mr-auto text-caption text-fg-tertiary">{problem}</span> : null}
          <Button variant="quiet" onClick={() => { close(false); }} disabled={saving}>{t("取消")}</Button>
          <Button variant="primary" pending={saving} disabled={problem !== null} onClick={() => void submit()}>{t("開始訓練")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
