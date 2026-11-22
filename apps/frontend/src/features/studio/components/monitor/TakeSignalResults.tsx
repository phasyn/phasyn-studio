import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import type { FileRef } from "@/api/generated/contracts";
import { apiJson, mediaUrl } from "@/api/http";
import type { WireRun } from "@/api/types";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/variants";
import { t } from "@/i18n";
import { errorText } from "@/lib/errors";
import { findingsOf, outputFile } from "./TakeSignalModel";

const PAGE = 15;
const MAX_REPORT_BYTES = 32 * 1024 * 1024;

function Report({ file, source, image }: { file: FileRef; source: FileRef; image: FileRef }) {
  const [page, setPage] = useState(0);
  const report = useQuery({
    queryKey: ["take-review", file.sha256, source.sha256, image.sha256],
    queryFn: async ({ signal }) => {
      if (file.size_bytes > MAX_REPORT_BYTES) throw new Error(t("報告超出預覽上限，請下載 JSON 查看。"));
      return findingsOf(await apiJson(mediaUrl(file.node_id, file.file_id), { signal }), source, image);
    },
    staleTime: Infinity,
    retry: false,
  });
  if (report.isPending) return <p role="status">{t("正在讀取檢查報告…")}</p>;
  if (report.isError) return <p role="alert" className="text-warning">{errorText(report.error)}</p>;
  const items = report.data;
  if (!items.length) return <p>{t("沒有達到門檻的黑場或靜止片段。")}</p>;
  return (
    <section className="grid gap-2" aria-label={t("需檢視的片段")}>
      <h3 className="font-semibold text-fg">{t("需檢視的片段（{count}）", { count: items.length })}</h3>
      <p className="text-caption text-fg-secondary">{t("範圍從第 0 格起算，結束格不包含在內。黑場與刻意停格可保留。")}</p>
      <ul className="grid gap-1">
        {items.slice(page * PAGE, (page + 1) * PAGE).map((item) => (
          <li key={JSON.stringify([item.kind, item.start_frame, item.end_frame])} className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-line-subtle py-1">
            <strong>{item.kind === "black" ? t("黑場") : t("畫面靜止")}</strong>
            <span className="machine">[{item.start_frame}, {item.end_frame}) · {item.start_seconds.toFixed(3)}–{item.end_seconds.toFixed(3)} s</span>
            <span className="text-fg-secondary">{t("證據影格 {frame}", { frame: item.evidence_frame })}{item.evidence_tile !== null ? t("（圖格 {number}）", { number: item.evidence_tile + 1 }) : ""}</span>
          </li>
        ))}
      </ul>
      {items.length > PAGE ? <div className="flex gap-2"><Button size="sm" disabled={page === 0} onClick={() => { setPage(page - 1); }}>{t("上一頁")}</Button><Button size="sm" disabled={(page + 1) * PAGE >= items.length} onClick={() => { setPage(page + 1); }}>{t("下一頁")}</Button></div> : null}
    </section>
  );
}

export function TakeSignalResults({ run, source }: { run: WireRun; source: FileRef }) {
  const report = outputFile(run, "report", "media.take_analysis.v1", "application/json");
  const evidence = outputFile(run, "evidence", "media.image.v1", "image/png");
  const control = outputFile(run, "control", "media.video.v1", "video/mp4");
  if (!report || !evidence || !control || [report, evidence, control].some((file) => file.metadata["source_sha256"] !== source.sha256)) {
    return <p role="alert" className="text-warning">{t("這次執行沒有交付與來源相符的報告、證據圖和輪廓影片。")}</p>;
  }
  const image = mediaUrl(evidence.node_id, evidence.file_id);
  return (
    <div className="grid gap-3 text-data">
      <Report file={report} source={source} image={evidence} />
      <a href={image} target="_blank" rel="noreferrer" title={t("開啟證據原圖")} className="block w-fit max-w-full rounded-md border border-line-subtle bg-stage">
        <img src={image} alt={t("來源影片的證據影格")} className="max-h-48 max-w-full object-contain" />
      </a>
      <div className="flex flex-wrap gap-2">
        <a className={buttonVariants({ variant: "primary", size: "sm" })} href={mediaUrl(control.node_id, control.file_id)} download={`edge-${source.sha256.slice(0, 12)}.mp4`}><Download aria-hidden />{t("下載輪廓影片")}</a>
        <a className={buttonVariants({ variant: "secondary", size: "sm" })} href={mediaUrl(report.node_id, report.file_id)} download={`review-${source.sha256.slice(0, 12)}.json`}>{t("下載檢查報告")}</a>
        <a className={buttonVariants({ variant: "secondary", size: "sm" })} href={image} download={`evidence-${source.sha256.slice(0, 12)}.png`}>{t("下載證據圖")}</a>
      </div>
    </div>
  );
}
