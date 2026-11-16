// 新增研究：來源圖片（上傳，或從 Studio 專案素材庫選一張圖）、名稱、Prompt 語言、額外局部觀察（最多 2 區）。
// 建立只保存研究文件（PUT revision 0）；分析要到研究裡明確按「分析原圖」才會呼叫視覺模型。上傳與保存都不自動重送。
// 局部座標欄保留打的原文（打到一半的「.」、「.8」或清空都不會先變成 0）；有座標讀不出 0–1 的數字時不能建立。
import { useQueryClient } from "@tanstack/react-query";
import { FileUp, ImagePlus, Plus, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import type { FileRef, StudioLibraryItem } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { ErrorCallout } from "@/components/common/ErrorCallout";
import { Disclosure } from "@/components/common/Disclosure";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { EmptyState } from "@/components/common/EmptyState";
import { MEDIA_FRAME, THUMB_ZOOM } from "@/components/ui/look";
import { SegmentedTabs } from "@/components/flow/SegmentedTabs";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { publishStudy, saveStudy, uploadSourceImage, useStudioProjectQuery, useStudioProjects } from "../api";
import { coordinateInRange, cropDraft, cropFromDraft, cropProblems, CROP_KEYS, MAX_CROPS, newCrop, sourceFileProblem, SOURCE_TYPES, titleFromFileName, type CropDraft, type CropKey } from "../model/crops";
import { LIMITS, LANGUAGE_LABELS } from "../model/sections";
import { newStudy } from "../model/study";
import type { PromptLanguage, PromptStudy } from "../types";
import { StudyImage } from "./shared";
import { t } from "@/i18n";

interface Source {
  file: FileRef;
  name: string;
  origin: "upload" | "library";
  /** 從 Studio 素材庫選的圖（研究建立後不可更換）。 */
  library: { project_id: string; item_id: string } | null;
}

function LibraryPicker({ onPick, selected }: { onPick: (item: StudioLibraryItem, projectId: string) => void; selected: string | null }) {
  const projects = useStudioProjects();
  const [projectId, setProjectId] = useState<string | null>(null);
  const project = useStudioProjectQuery(projectId);
  const images = (project.data?.library ?? []).filter((item) => item.kind === "image");
  const id = useId();
  return (
    <div className="grid gap-2">
      <label htmlFor={`${id}-project`} className="text-caption text-fg-secondary">
        {t("Studio 專案")}
      </label>
      {projects.isError ? (
        <ErrorCallout error={projects.error} title={t("無法讀取 Studio 專案列表")} onRetry={() => void projects.refetch()} retrying={projects.isFetching} />
      ) : (
        <Select id={`${id}-project`} compact value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value || null)} disabled={projects.isPending}>
          <option value="">{projects.isPending ? t("讀取中…") : t("選擇專案")}</option>
          {(projects.data?.items ?? []).map((item) => (
            <option key={item.project_id} value={item.project_id}>
              {item.title}
            </option>
          ))}
        </Select>
      )}
      {projectId === null ? null : project.isPending ? (
        <p role="status" className="text-caption text-fg-secondary">
          {t("讀取素材庫…")}
        </p>
      ) : project.isError ? (
        <ErrorCallout error={project.error} title={t("無法讀取專案")} onRetry={() => void project.refetch()} retrying={project.isFetching} />
      ) : images.length === 0 ? (
        <p className="text-caption text-fg-tertiary">{t("這個專案的素材庫沒有圖片。")}</p>
      ) : (
        <ul className="grid max-h-64 grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2 overflow-auto" aria-label={t("素材庫圖片")}>
          {images.map((item) => (
            <li key={item.item_id}>
              <button
                type="button"
                aria-pressed={selected === item.file.file_id}
                onClick={() => projectId && onPick(item, projectId)}
                className="pressable group/tile grid w-full gap-1 rounded-lg border border-line-subtle p-1 text-left text-caption text-fg-secondary hover:border-line-control aria-pressed:border-brand-blue/60 aria-pressed:bg-brand-gradient-soft aria-pressed:text-fg focus-visible:outline-2 focus-visible:outline-focus"
              >
                <span className="block overflow-hidden rounded-md">
                  <span className={cn("block", THUMB_ZOOM)}>
                    <StudyImage file={item.file} alt={item.name} className="aspect-square w-full rounded-md border-0" />
                  </span>
                </span>
                <span className="truncate" title={item.name}>
                  {item.name}
                </span>
                <span className="machine text-fg-tertiary">{item.width && item.height ? `${item.width}×${item.height}` : t("尺寸未知")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CreateStudyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (study: PromptStudy) => void }) {
  const client = useQueryClient();
  const id = useId();
  const [tab, setTab] = useState<"upload" | "library">("upload");
  const [source, setSource] = useState<Source | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<PromptLanguage>("zh-TW");
  const [cropDrafts, setCropDrafts] = useState<CropDraft[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProblem, setUploadProblem] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setTab("upload");
    setSource(null);
    setSize(null);
    setTitle("");
    setLanguage("zh-TW");
    setCropDrafts([]);
    setUploadProblem(null);
    setError(null);
  };
  const close = (next: boolean) => {
    if (saving || uploading) return;
    if (!next) reset();
    onOpenChange(next);
  };

  const pickSource = (next: Source) => {
    setSource(next);
    setSize(null);
    setError(null);
    if (!title.trim()) setTitle(titleFromFileName(next.name));
  };

  const upload = async (file: File) => {
    const problem = sourceFileProblem(file);
    setUploadProblem(problem);
    if (problem) return;
    setUploading(true);
    setError(null);
    try {
      pickSource({ file: await uploadSourceImage(file), name: file.name, origin: "upload", library: null });
    } catch (cause) {
      setError(cause);
    } finally {
      setUploading(false);
    }
  };

  const crops = cropDrafts.map(cropFromDraft);
  const problems = cropProblems(crops, size);
  const blockReason = uploading
    ? t("上傳中")
    : !source
      ? t("請先上傳或選擇來源圖片")
      : !size
        ? t("等待讀取圖片尺寸（圖片無法載入時不能建立：原圖建立後不可更換）")
        : title.length > LIMITS.title
        ? t("名稱最多 {title} 字", { title: LIMITS.title })
        : problems.length > 0
          ? problems[0] ?? null
          : null;

  const create = async () => {
    if (blockReason || !source || saving) return;
    setSaving(true);
    setError(null);
    try {
      const study = newStudy({
        title,
        source: { file: source.file, name: (source.name.trim() || "source").slice(0, 200), width: size?.width ?? null, height: size?.height ?? null, library_item: source.library },
        language,
        crops,
        now: new Date().toISOString(),
      });
      const saved = await saveStudy(study);
      publishStudy(client, saved);
      reset();
      onCreated(saved);
    } catch (cause) {
      setError(cause);
    } finally {
      setSaving(false);
    }
  };

  const updateCrop = (index: number, key: CropKey, text: string) => setCropDrafts((current) => current.map((draft, at) => (at === index ? { ...draft, [key]: text } : draft)));

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent wide>
        <DialogHeader>
          <DialogTitle>{t("新增圖片反推研究")}</DialogTitle>
          <DialogDescription>{t("來源圖片只用於分析與比較，不會成為生成的參考圖。原圖、語言與局部觀察建立後不可更換；按「分析原圖」才會呼叫視覺模型。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4 @container">
          <div className="grid gap-4 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <section className="grid content-start gap-2" aria-labelledby={`${id}-source-title`}>
              <h3 id={`${id}-source-title`} className="text-data font-semibold text-fg">
                {t("來源圖片")}
              </h3>
              <SegmentedTabs
                tabs={[
                  { id: "upload", label: t("上傳") },
                  { id: "library", label: t("Studio 素材庫") },
                ]}
                value={tab}
                onChange={(next) => setTab(next === "library" ? "library" : "upload")}
                idPrefix={`${id}-source`}
                label={t("來源圖片的取得方式")}
                className="w-fit"
              />
              <div role="tabpanel" id={`${id}-source-panel-upload`} aria-labelledby={`${id}-source-tab-upload`} hidden={tab !== "upload"} className="grid gap-2">
                <label
                  htmlFor={`${id}-file`}
                  className={cn(
                    "pressable inline-flex min-h-8 w-fit cursor-pointer items-center gap-2 rounded-lg border border-line-control bg-raised px-3 text-data text-fg hover:border-fg-tertiary hover:bg-overlay has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus [&_svg]:size-4",
                    uploading && "border-brand-blue/40 bg-brand-gradient-soft animate-shimmer",
                  )}
                >
                  <FileUp aria-hidden />
                  {uploading ? t("上傳中…") : source?.origin === "upload" ? t("更換圖片") : t("選擇圖片")}
                  <input
                    id={`${id}-file`}
                    type="file"
                    className="sr-only"
                    accept={SOURCE_TYPES.join(",")}
                    disabled={uploading || saving}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (file) void upload(file);
                    }}
                  />
                </label>
                <p className="text-caption text-fg-tertiary">{t("PNG、JPEG 或 WebP，最多 24 MiB；透明區在視覺模型輸入時合成白底。")}</p>
                {uploadProblem ? <p className="text-caption text-danger">{uploadProblem}</p> : null}
              </div>
              <div role="tabpanel" id={`${id}-source-panel-library`} aria-labelledby={`${id}-source-tab-library`} hidden={tab !== "library"}>
                {tab === "library" ? <LibraryPicker selected={source?.origin === "library" ? source.file.file_id : null} onPick={(item, projectId) => pickSource({ file: item.file, name: item.name, origin: "library", library: { project_id: projectId, item_id: item.item_id } })} /> : null}
              </div>
            </section>
            <section className="grid content-start gap-2" aria-label={t("預覽")}>
              {source ? (
                <>
                  <div className={cn(MEDIA_FRAME, "animate-rise-in")}>
                    <StudyImage key={source.file.file_id} file={source.file} alt={t("來源圖片預覽")} className="max-h-72 w-full rounded-none border-0 bg-transparent" onSize={(width, height) => setSize({ width, height })} />
                  </div>
                  <p className="machine text-caption text-fg-tertiary">{`${size ? `${size.width}×${size.height}` : t("尺寸讀取中")} · ${source.file.media_type} · ${formatBytes(source.file.size_bytes)}`}</p>
                </>
              ) : (
                <div className="grid min-h-40 place-items-center rounded-xl border border-dashed border-line-strong bg-canvas/60">
                  <EmptyState icon={<ImagePlus />} size="compact" title={t("還沒有來源圖片")} description={t("上傳一張圖，或從 Studio 素材庫選一張。")} />
                </div>
              )}
            </section>
          </div>
          <div className="grid gap-3 @lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="grid gap-1">
              <label htmlFor={`${id}-title`} className="text-caption text-fg-secondary">
                {t("研究名稱")}
              </label>
              <Input id={`${id}-title`} compact maxLength={LIMITS.title} value={title} placeholder={t("未命名研究")} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="grid gap-1">
              <label htmlFor={`${id}-language`} className="text-caption text-fg-secondary">
                {t("Prompt 語言")}
              </label>
              <Select id={`${id}-language`} compact value={language} onChange={(event) => setLanguage(event.target.value === "en" ? "en" : "zh-TW")}>
                <option value="zh-TW">{LANGUAGE_LABELS["zh-TW"]}</option>
                <option value="en">{LANGUAGE_LABELS.en}</option>
              </Select>
            </div>
          </div>
          <Disclosure summary={t("額外局部觀察（最多 {maxCrops} 區，{cropsCount} 區）", { maxCrops: MAX_CROPS, cropsCount: crops.length })}>
            <div className="grid gap-2">
              <p className="text-caption text-fg-tertiary">{t("座標以 0–1 表示（左上 x0,y0、右下 x1,y1），全圖一定會一起分析；換算後每區至少 32×32 px。")}</p>
              {cropDrafts.map((draft, index) => {
                const crop = cropFromDraft(draft);
                return (
                  <fieldset key={draft.view_id} className="grid grid-cols-[auto_repeat(4,minmax(0,1fr))_auto] items-end gap-2">
                    <legend className="sr-only">{draft.view_id}</legend>
                    <span className="machine pb-1.5 text-caption text-fg-secondary">{draft.view_id}</span>
                    {CROP_KEYS.map((key) => {
                      const invalid = !coordinateInRange(crop[key]);
                      return (
                        <div key={key} className="grid gap-0.5">
                          <label htmlFor={`${id}-${draft.view_id}-${key}`} className="machine text-caption text-fg-tertiary">
                            {key}
                          </label>
                          {/* 文字欄而不是 type="number"：數字欄打到一半（「.」）或清空時回報空字串，受控的值會把它改寫成 0 */}
                          <Input
                            id={`${id}-${draft.view_id}-${key}`}
                            compact
                            inputMode="decimal"
                            className="machine"
                            value={draft[key]}
                            aria-invalid={invalid || undefined}
                            aria-describedby={invalid ? `${id}-crop-problems` : undefined}
                            onChange={(event) => updateCrop(index, key, event.target.value)}
                          />
                        </div>
                      );
                    })}
                    <Button size="icon-sm" variant="danger" aria-label={t("移除 {view_id}", { view_id: draft.view_id })} title={t("移除 {view_id}", { view_id: draft.view_id })} onClick={() => setCropDrafts((current) => current.filter((_, at) => at !== index))}>
                      <Trash2 aria-hidden />
                    </Button>
                  </fieldset>
                );
              })}
              {problems.length > 0 ? (
                <ul id={`${id}-crop-problems`} className="grid gap-0.5 text-caption text-danger">
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              ) : null}
              <Button
                size="sm"
                icon={<Plus aria-hidden />}
                className="w-fit"
                disabled={crops.length >= MAX_CROPS}
                title={crops.length >= MAX_CROPS ? t("最多 {maxCrops} 區", { maxCrops: MAX_CROPS }) : undefined}
                onClick={() => {
                  const crop = newCrop(crops);
                  if (crop) setCropDrafts((current) => [...current, cropDraft(crop)]);
                }}
              >
                {t("新增局部")}
              </Button>
            </div>
          </Disclosure>
          {error ? <ErrorCallout error={error} write title={source ? t("建立研究失敗；輸入保留") : t("上傳失敗")} /> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="quiet" onClick={() => close(false)} disabled={saving || uploading}>
            {t("取消")}
          </Button>
          <ActionButton variant="primary" icon={<ImagePlus aria-hidden />} pending={saving} disabledReason={saving ? null : blockReason} onClick={() => void create()}>
            {t("建立研究")}
          </ActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
