import { useQuery } from "@tanstack/react-query";
import { Archive, Download, Palette } from "lucide-react";
import { apiJson, buildUrl } from "@/api/http";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/variants";
import { isRecord } from "@/lib/json";
import { t } from "@/i18n";
import { downloadJson } from "@/lib/download";
import { errorText } from "@/lib/errors";
import { pathSegment } from "@/lib/url";
import { OtioExchangeReference } from "../editor/timeline/OtioExchangeReference";
import { OtioExchangeImport } from "../editor/timeline/OtioExchangeImport";
import { useEditor } from "../editor/editorContext";


/** Media downloads go to the browser's download manager. Only the timeline JSON is held in this tab. */
export function OtioExport() {
  const { project, flush } = useEditor();
  const projectId = project.project_id;
  const path = `/api/studio/projects/${pathSegment(projectId)}/timeline/otio`;
  const preview = useQuery({
    queryKey: ["studio", projectId, "otio", project.revision],
    queryFn: async ({ signal }) => {
      await flush();
      const exchange = await apiJson(path, { signal });
      const timeline = isRecord(exchange) ? exchange["document"] : null;
      const metadata = isRecord(timeline) ? timeline["metadata"] : null;
      const phasyn = isRecord(metadata) ? metadata["phasyn"] : null;
      if (!isRecord(exchange) || exchange["project_id"] !== projectId ||
          typeof exchange["revision"] !== "number" || !Number.isSafeInteger(exchange["revision"]) ||
          !isRecord(timeline) || timeline["OTIO_SCHEMA"] !== "Timeline.1" ||
          !isRecord(phasyn) || !Array.isArray(phasyn["media"]) || !Array.isArray(phasyn["report"])) {
        throw new Error(t("無法辨識這個專案的 OTIO 時間軸。"));
      }
      const regions = exchange["delivery_region_count"];
      return { revision: exchange["revision"], timeline, sources: phasyn["media"].length, notes: phasyn["report"].length,
        regions: typeof regions === "number" ? regions : null };
    },
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnMount: "always",
  });
  if (preview.isFetching || preview.isPending) return <p role="status" className="text-body text-fg-secondary">{t("正在讀取已儲存的時間軸…")}</p>;
  if (preview.isError) {
    return (
      <div className="grid justify-items-start gap-3">
        <p role="alert" className="text-body text-warning">{errorText(preview.error)}</p>
        <Button onClick={() => void preview.refetch()}>{t("重新讀取")}</Button>
      </div>
    );
  }
  const { revision, timeline, sources, notes, regions } = preview.data;
  const basename = `${projectId}-r${String(revision)}`;

  return (
    <section className="grid gap-4">
      {/* Plain words; the saved revision the files come from is only in the tooltip */}
      <p className="text-caption text-fg-secondary" title={t("依已儲存的第 {revision} 版時間軸產生", { revision })}>
        {notes > 0
          ? t("時間軸用到 {sources} 個素材；有 {notes} 處效果在外部剪輯軟體無法完全重現，交換包裡的報告會逐一說明。", { sources, notes })
          : t("時間軸用到 {sources} 個素材，全部效果都能轉換。", { sources })}
      </p>
      <OtioExchangeReference key={basename} path={path} basename={basename} revision={revision} regions={regions} />
      <OtioExchangeImport key={basename + "-edits"} path={path} revision={revision} />
      <div className="grid gap-2 rounded-lg border border-line-subtle p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
        <div className="grid gap-1">
          <h3 className="text-body font-semibold text-fg">{t("含素材的剪輯交換包")}</h3>
          <p className="text-caption text-fg-secondary">{t("解壓縮後，以剪輯軟體開啟 timeline.otio。包內另附素材清單、缺檔與效果轉換報告。")}</p>
        </div>
        <a href={buildUrl(`${path}.zip`, { revision })} download={`${basename}.zip`} className={buttonVariants({ variant: "primary", size: "sm" })}>
          <Archive aria-hidden />{t("下載 ZIP")}
        </a>
      </div>
      <div className="grid gap-2 rounded-lg border border-line-subtle p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
        <div className="grid gap-1">
          <h3 className="text-body font-semibold text-fg">{t("僅時間軸")}</h3>
          <p className="text-caption text-fg-secondary">{t("已有素材時，可單獨下載剪輯結構並在剪輯軟體中重新連結媒體。")}</p>
        </div>
        <Button size="sm" variant="secondary" icon={<Download aria-hidden />} onClick={() => { downloadJson(`${basename}.otio`, timeline); }}>{t("下載 .otio")}</Button>
      </div>
      {/* The art round-trip itself starts from the shot's 修正 menu; this is the one-time plugin install for Krita */}
      <div className="grid gap-2 rounded-lg border border-line-subtle p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
        <div className="grid gap-1">
          <h3 className="text-body font-semibold text-fg">{t("Krita 美術交換插件")}</h3>
          <p className="text-caption text-fg-secondary">{t("在 Krita 安裝一次後，就能從鏡頭的「修正」選單把畫面送到 Krita 修圖，修好再送回成為新的版本。")}</p>
        </div>
        <a href="/phasyn-krita.zip" download className={buttonVariants({ variant: "secondary", size: "sm" })}>
          <Palette aria-hidden />{t("下載插件")}
        </a>
      </div>
    </section>
  );
}
