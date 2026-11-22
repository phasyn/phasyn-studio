import { CircleCheck, Film, Layers, ScanText, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useCatalog, useProviderIndex } from "@/api/catalog";
import type { Asset, CaptionPair, FileRef } from "@/api/generated/contracts";
import { asAsset, asCaptionPair, asSceneDocument, type WireRun, type WireTypedValue } from "@/api/types";
import { AssetPlayer, type AssetLabel } from "@/components/common/AssetPlayer";
import { Disclosure } from "@/components/common/Disclosure";
import { FileRefView } from "@/components/common/FileRefView";
import { JsonView } from "@/components/common/JsonView";
import { SyntheticBadge } from "@/components/common/SyntheticNotice";
import { IdText } from "@/components/common/values";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KeyValueList } from "@/components/ui/kv";
import { buttonVariants } from "@/components/ui/variants";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { componentOptions } from "@/features/pipelines";
import { FinalDecodeDialog, type FinalDecodeSeed } from "./FinalDecodeDialog";
import { compareSources, durationSeconds, fpsValue, latentFacts, previewAssetForLatent } from "./runModel";
import { materialRows } from "./materialsView";
import { MediaPreview } from "@/components/values/MediaPreview";
import { recordingPath, semanticsPath } from "@/app/paths";
import { tServer, t } from "@/i18n";
import { T } from "@/i18n/T";

const KIND_LABEL: Record<Asset["kind"], AssetLabel> = { preview: "preview", final: "final", video: "video", audio: "audio" };

/** 同源標示：latent_id、blob SHA、manifest SHA 全同才是「同源」；否則「來源不同」，不冒充。 */
export function SourceBadge({ a, b }: { a: Asset; b: Asset }) {
  const relation = compareSources(a.source_latent, b.source_latent);
  return relation.same ? (
    <Badge tone="success">
      <CircleCheck aria-hidden />
      {t("同源（latent_id、blob 與 manifest SHA 相同）")}
    </Badge>
  ) : (
    <Badge tone="warning" title={relation.reason}>
      <TriangleAlert aria-hidden />
      {t("來源不同：{reason}", { reason: relation.reason })}
    </Badge>
  );
}

export function AssetCard({ asset, run }: { asset: Asset; run: WireRun }) {
  const [decode, setDecode] = useState<FinalDecodeSeed | null>(null);
  const fps = fpsValue(asset.fps);
  const duration = durationSeconds(asset.frame_count, asset.fps);
  return (
    <div className="grid min-w-0 gap-3">
      <AssetPlayer
        file={asset.file}
        label={KIND_LABEL[asset.kind]}
        title={`asset ${asset.asset_id.slice(0, 8)}`}
        width={asset.width || null}
        height={asset.height || null}
      />
      {!asset.complete ? (
        <p className="flex items-center gap-1.5 text-caption text-warning" role="note">
          <TriangleAlert aria-hidden className="size-3.5" />
          {t("未完成（complete=false）：這不是完整成片，首幀可看不代表整段完成。")}
        </p>
      ) : null}
      <KeyValueList
        dense
        items={[
          { key: "kind", label: t("種類"), value: asset.kind, mono: true },
          { key: "frames", label: t("幀數"), value: String(asset.frame_count), mono: true },
          { key: "fps", label: "FPS", value: asset.fps ? `${String(asset.fps.num)}/${String(asset.fps.den)}${fps !== null ? t("（{fps}）", { fps: fps.toFixed(3) }) : ""}` : "—", mono: true },
          { key: "duration", label: t("長度"), value: duration !== null ? t("{duration} s（frames×den/num）", { duration: duration.toFixed(3) }) : "—", mono: true },
          { key: "size", label: t("畫幅"), value: asset.width && asset.height ? `${String(asset.width)}×${String(asset.height)}` : "—", mono: true },
          { key: "complete", label: t("完成"), value: asset.complete ? t("是（encoder flush 與 frame count 已核對）") : t("否"), tone: asset.complete ? "default" : "warning" },
          {
            key: "source",
            label: t("來源 latent"),
            value: asset.source_latent ? (
              <span className="grid gap-0.5">
                <span>
                  latent_id <IdText value={asset.source_latent.latent_id} />
                </span>
                <span>
                  blob <IdText value={asset.source_latent.blob_sha256} length={12} /> · manifest <IdText value={asset.source_latent.manifest_sha256} length={12} />
                </span>
              </span>
            ) : (
              t("無 source_latent（不能用於同源比較）")
            ),
          },
        ]}
      />
      {Object.keys(asset.actual_settings).length > 0 ? (
        <Disclosure summary={t("實際設定（actual_settings）")}>
          <JsonView value={asset.actual_settings} label="actual_settings" maxHeightClass="max-h-56" />
        </Disclosure>
      ) : null}
      {asset.kind === "preview" && asset.source_latent ? (
        <div>
          <Button
            variant="primary"
            icon={<Film aria-hidden />}
            onClick={() => {
              if (!asset.source_latent) return;
              setDecode({ latent: asset.source_latent.manifest_file, sourceRunId: run.run_id, previewAssetId: asset.asset_id, mode: "from-preview" });
            }}
          >
            {t("從此來源正式解碼")}
          </Button>
        </div>
      ) : null}
      <FinalDecodeDialog seed={decode} onOpenChange={(open) => { if (!(open)) { setDecode(null); } }} />
    </div>
  );
}

function PreviewDecoderStatus() {
  const catalog = useCatalog();
  const providers = useProviderIndex((catalog.data?.nodes ?? []).map((node) => node.node_id));
  const decoders = componentOptions(catalog.data, providers).filter((option) => option.kind === "decode.preview");
  const unavailable = [...providers.byRuntime.values()].filter((item) => item.kind === "decode.preview" && !item.available);
  if (decoders.length > 0) {
    return <p className="text-caption text-fg-tertiary">{t("草稿解碼器（decode.preview）：目錄中有 {decodersCount} 個元件，可在流程中使用。", { decodersCount: decoders.length })}</p>;
  }
  return (
    <p className="text-caption text-fg-tertiary">
      {t("草稿解碼器：未配置 preview decoder{value}。正式解碼、語意分析與其他元件仍可使用。", { value: unavailable.length > 0 ? t("（{map}）", { map: unavailable.map((item) => t("{provider_id}：{value}", { provider_id: item.provider_id, value: tServer(item.reason) ?? t("不可用") })).join(t("；")) }) : "" })}
    </p>
  );
}

export function LatentCard({ file, run }: { file: FileRef; run: WireRun }) {
  const [decode, setDecode] = useState<FinalDecodeSeed | null>(null);
  const facts = latentFacts(file);
  const preview = previewAssetForLatent(run, file);
  return (
    <div className="grid min-w-0 gap-3">
      <KeyValueList
        dense
        items={[
          { key: "latent", label: "latent_id", value: <IdText value={facts.latentId} /> },
          { key: "space", label: "latent_space_id", value: facts.latentSpaceId ?? t("未知"), mono: true },
          { key: "shape", label: "shape", value: facts.shape ? `[${facts.shape.join(", ")}]` : t("未知"), mono: true },
          { key: "dtype", label: "dtype", value: facts.dtype ?? t("未知"), mono: true },
          { key: "layout", label: "layout", value: facts.layout ?? "—", mono: true },
          {
            key: "blob",
            label: "blob",
            value: facts.blob ? (
              <span>
                {formatBytes(facts.blob.size_bytes)} · SHA <IdText value={facts.blob.sha256} length={12} />
              </span>
            ) : (
              t("manifest 沒有連結 blob（metadata.links.blob）")
            ),
          },
          { key: "manifest", label: "manifest", value: <IdText value={file.sha256} length={12} /> },
        ]}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={<Film aria-hidden />}
          onClick={() => { setDecode({ latent: file, sourceRunId: run.run_id, previewAssetId: preview?.asset_id ?? null, mode: "from-preview" }); }}
        >
          {t("從此來源正式解碼")}
        </Button>
        <Button icon={<Layers aria-hidden />} onClick={() => { setDecode({ latent: file, sourceRunId: run.run_id, previewAssetId: null, mode: "direct" }); }}>
          {t("直接完整解碼")}
        </Button>
      </div>
      <p className="text-caption text-fg-tertiary">
        {preview ? t("本 run 的草稿 asset {asset_id} 來自此 latent；「從此來源正式解碼」會記錄它。", { asset_id: preview.asset_id.slice(0, 8) }) : t("本 run 沒有以此 latent 產生的草稿。")}
      </p>
      <PreviewDecoderStatus />
      <FinalDecodeDialog seed={decode} onOpenChange={(open) => { if (!(open)) { setDecode(null); } }} />
    </div>
  );
}

export function CaptionPairView({ pair }: { pair: CaptionPair }) {
  return (
    <div className="grid min-w-0 gap-3">
      <div className="grid gap-3 md:grid-cols-2">
        <section className="grid content-start gap-1 rounded-md border border-line-subtle bg-sunken p-3" aria-label="training caption">
          <h4 className="text-caption font-semibold text-fg-secondary">{t("training caption（只用觀測事實）")}</h4>
          <p className="text-reading whitespace-pre-wrap text-fg">{pair.training_caption || t("（空 caption：資料錯誤）")}</p>
        </section>
        <section className="grid content-start gap-1 rounded-md border border-line-subtle bg-sunken p-3" aria-label="generation prompt">
          <h4 className="text-caption font-semibold text-fg-secondary">{t("generation prompt（含 generation edits）")}</h4>
          <p className="text-reading whitespace-pre-wrap text-fg">{pair.generation_prompt || t("（空）")}</p>
        </section>
      </div>
      <p className="text-caption text-fg-tertiary">
        <T source={"語言 <0>{language}</0> · include_uncertain {value} · 來源 <1/>{value2}。generation edits 不會進入 training caption。"} values={{ language: pair.language, value: pair.include_uncertain ? t("是") : t("否"), value2: (pair.scene_recording_id != null && pair.scene_recording_id !== "") ? (
          <T source={"{text}· Scene 紀錄 <0>{scene_recording_id}</0>"} values={{ text: " ", scene_recording_id: pair.scene_recording_id.slice(0, 8) }} slots={[<Link key="slot-0" to={recordingPath(pair.scene_recording_id)} />]} />
        ) : null }} slots={[<code key="slot-0" className="machine" />, <IdText key="slot-1" value={pair.source.file_id} />]} />
      </p>
    </div>
  );
}

/**
 * h3.materials.v1（參考素材）：依送出順序列出縮圖、H3 標籤、角色、檔案事實、裁切與影片原聲；
 * 形狀不符時顯示原始 JSON。FileRef 沒有記錄原始檔名。
 */
export function MaterialsView({ name, value }: { name: string; value: unknown }) {
  const rows = materialRows(value);
  if (!rows) return <JsonView value={value} label={t("{name}（無法解析為參考素材）", { name })} maxHeightClass="max-h-64" />;
  if (rows.length === 0) return <p className="text-caption text-fg-tertiary">{t("沒有參考素材。")}</p>;
  return (
    <div className="grid min-w-0 gap-2">
      <ol className="grid gap-1.5" aria-label={t("{name}（依送出順序）", { name })}>
        {rows.map((row) => (
          <li key={`${String(row.position)}:${row.file.file_id}`} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-md border border-line-subtle bg-sunken/50 p-2">
            <MediaPreview file={row.file} title={`${row.roleLabel} ${String(row.position)}`} size="thumb" />
            <div className="grid min-w-0 gap-1 text-caption">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="machine text-fg-tertiary">#{row.position}</span>
                <code
                  className={cn("machine rounded-sm border px-1", (row.tag != null && row.tag !== "") ? "border-entity/30 bg-entity/12 text-entity" : "border-line bg-raised text-fg-tertiary")}
                  title={(row.tag != null && row.tag !== "") ? t("prompt 中以 {tag} 引用", { tag: row.tag }) : t("編號無法確定（前面有原聲未知的參考影片，或有不認得的角色）")}
                >
                  {row.tag ?? "<?>"}
                </code>
                <span className="text-fg">{row.roleLabel}</span>
                {(row.range != null && row.range !== "") ? <span className="text-fg-secondary">{t("使用 {range}", { range: row.range })}</span> : null}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-fg-tertiary">
                <span className="machine">{row.file.media_type || t("未知類型")}</span>
                <span className="machine">{formatBytes(row.file.size_bytes)}</span>
                <span>
                  file <IdText value={row.file.file_id} />
                </span>
              </div>
              {row.soundtrack ? (
                <p className="text-fg-tertiary">
                  {row.soundtrack.state === "off"
                    ? t("影片原聲：關閉（use_embedded_audio=false）")
                    : t("影片原聲：預設使用；影片有音軌時會多佔一個 <Audio n>（由元件 probe 決定）")}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
      <p className="text-caption text-fg-tertiary">{t("FileRef 沒有記錄上傳時的檔名，只列出檔案事實；H3 依同類素材在請求中的順序編號。")}</p>
      <Disclosure summary={t("原始 JSON")}>
        <JsonView value={value} label={name} maxHeightClass="max-h-64" />
      </Disclosure>
    </div>
  );
}

/** 輸出檢視：依 type_id 呈現 Asset 播放、final latent、caption、Scene、參考素材、檔案事實或 inline JSON。 */
export function TypedValueView({ name, value, run, usage }: { name: string; value: WireTypedValue; run: WireRun; usage: "input" | "output" }) {
  const isTest = value.type_id.startsWith("test.");
  let body: React.ReactNode;
  if (value.type_id === "media.asset.v1" && "value" in value) {
    const asset = asAsset(value.value);
    body = asset ? <AssetCard asset={asset} run={run} /> : <JsonView value={value.value} label={t("{name}（無法解析為 Asset）", { name })} />;
  } else if (value.type_id.endsWith("final-latent.v1") && "file" in value) {
    body = value.type_id === "video.final-latent.v1" ? <LatentCard file={value.file} run={run} /> : <FileRefView file={value.file} downloadLabel={name} />;
  } else if (value.type_id === "caption.pair.v1" && "value" in value) {
    const pair = asCaptionPair(value.value);
    body = pair ? <CaptionPairView pair={pair} /> : <JsonView value={value.value} label={name} />;
  } else if (value.type_id === "video.scene.v1") {
    const inlineScene = "value" in value ? asSceneDocument(value.value) : null;
    body = (
      <div className="grid gap-2">
        {"file" in value ? <FileRefView file={value.file} downloadLabel="scene" /> : null}
        {inlineScene ? (
          <p className="text-caption text-fg-secondary">
            {t("Scene：{duration_seconds} s · {eventsCount} 個事件 · {entitiesCount} 個主體", { duration_seconds: inlineScene.duration_seconds, eventsCount: inlineScene.events.length, entitiesCount: inlineScene.entities.length })}
          </p>
        ) : null}
        <Link to={semanticsPath({ describe_run: run.run_id })} className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <ScanText aria-hidden />
          {t("在語意頁查看與編輯")}
        </Link>
      </div>
    );
  } else if (value.type_id === "h3.materials.v1" && "value" in value) {
    body = <MaterialsView name={name} value={value.value} />;
  } else if (value.type_id.startsWith("text.") && "value" in value && typeof value.value === "string") {
    body = <p className="text-reading whitespace-pre-wrap text-fg">{value.value}</p>;
  } else if ("file" in value && (value.type_id === "media.video.v1" || value.type_id === "media.image.v1" || value.type_id === "media.audio.v1")) {
    const kind = value.type_id === "media.video.v1" ? "video" : value.type_id === "media.image.v1" ? "image" : "audio";
    body = <AssetPlayer file={value.file} label={kind} title={name} />;
  } else if ("file" in value) {
    body = (
      <div className="grid gap-2">
        {value.type_id.startsWith("h3.") ? <p className="text-caption text-fg-tertiary">{t("模型專屬的 bundle（不透明）：只顯示檔案事實。")}</p> : null}
        <FileRefView file={value.file} downloadLabel={name} />
      </div>
    );
  } else {
    body = <JsonView value={value.value} label={name} maxHeightClass="max-h-64" />;
  }
  return (
    <section className="grid min-w-0 gap-2 rounded-lg border border-line-subtle bg-surface p-3" aria-label={usage === "input" ? t("輸入 {name}", { name }) : t("輸出 {name}", { name })}>
      <p className="flex flex-wrap items-center gap-2 text-data">
        <code className="machine font-semibold text-fg">{name}</code>
        <code className="machine text-caption text-file">{value.type_id}</code>
        <Badge>{"file" in value ? t("檔案") : "inline"}</Badge>
        {isTest ? <SyntheticBadge kind="test" /> : null}
      </p>
      {body}
    </section>
  );
}
