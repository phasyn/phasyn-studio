// 監看器下方的 take 資訊：比較時兩個 take 的參數差異表；完成的 take 的一行摘要（尺寸、步數…、總耗時）與可展開的詳細
// （run、建立時間、路由、seed、prompt、各步驟耗時、圖片格式）。耗時只用 take 記下的步驟時間，沒有記錄就說未量測。
import { ChevronDown, ExternalLink } from "lucide-react";
import { useId, useState } from "react";
import { Link } from "react-router";
import { IdText } from "@/components/common/values";
import { Expand } from "@/components/flow/Expand";
import { cn } from "@/lib/cn";
import { formatMs, formatTimestamp } from "@/lib/format";
import { DECODE_LABELS, MODE_LABELS, ROLE_LABELS, SIGMA_LABELS } from "../model/constants";
import { takeTotal } from "../model/outcome";
import { snapshotDiff, takeSnapshot } from "../model/params";
import type { StudioImageTake } from "../types";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

export function DiffTable({ a, b }: { a: StudioImageTake; b: StudioImageTake }) {
  const left = takeSnapshot(a);
  const right = takeSnapshot(b);
  if (!left || !right) return <p className="px-3 pb-2 text-caption text-fg-tertiary">{t("有 take 沒有參數紀錄，無法比較參數。")}</p>;
  const rows = snapshotDiff(left, right);
  if (rows.length === 0) return <p className="px-3 pb-2 text-caption text-fg-tertiary">{t("兩個 take 的參數相同。")}</p>;
  return (
    <table className="mx-3 mb-2 table-fixed border-separate border-spacing-x-2 text-caption">
      <caption className="sr-only">{t("A 與 B 的參數差異")}</caption>
      <thead>
        <tr className="text-left text-fg-tertiary">
          <th scope="col" className="w-24 font-medium">{t("參數")}</th>
          <th scope="col" className="font-medium">A</th>
          <th scope="col" className="font-medium">B</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, valueA, valueB]) => (
          <tr key={label}>
            <th scope="row" className="text-left font-normal text-fg-tertiary">
              {label}
            </th>
            <td className="machine max-w-0 truncate text-fg-secondary" title={valueA}>
              {valueA}
            </td>
            <td className="machine max-w-0 truncate text-fg" title={valueB}>
              {valueB}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A step of timings_ms by its role's name when the step id is a role (te, dit…), else the id itself. */
function stepName(key: string): string {
  return (ROLE_LABELS as Record<string, string>)[key] ?? key;
}

/** The take's total time: its own steps' sum, or why it is not measured. */
function totalText(take: StudioImageTake): string {
  const total = takeTotal(take.timings_ms);
  if (total.ms !== null) return t("總耗時 {formatMs}", { formatMs: formatMs(total.ms) });
  if (total.missing.length > 0) return t("總耗時 未量測（{steps} 沒有開始或結束時間）", { steps: formatList(total.missing.map(stepName)) });
  return t("總耗時 未量測（沒有記錄這張圖片的步驟時間）");
}

export function Facts({ take }: { take: StudioImageTake }) {
  const snap = takeSnapshot(take);
  const [open, setOpen] = useState(false);
  const id = useId();
  const timings = Object.entries(take.timings_ms).filter(([key]) => key !== "total");
  const summary = snap
    ? t("{width}×{height}・{steps} 步・guidance {guidance}・{sigma_schedule}・μ {value}・{decode}・{mode}{value2}{value3}", { width: snap.width, height: snap.height, steps: snap.steps, guidance: snap.guidance, sigma_schedule: SIGMA_LABELS[snap.sigma_schedule], value: snap.flow_shift_mu ?? t("自動"), decode: DECODE_LABELS[snap.decode], mode: MODE_LABELS[snap.mode], value2: snap.references.length > 0 ? t("・參考 {referencesCount} 張", { referencesCount: snap.references.length }) : "", value3: snap.mask_item_id ? t("・遮罩") : "" })
    : null;
  return (
    <div className="shrink-0 border-t border-line-subtle bg-canvas">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-caption text-fg-tertiary">
        {summary ? (
          <span className="machine min-w-0 truncate" title={summary}>
            {summary}
          </span>
        ) : (
          <span>{t("沒有參數紀錄")}</span>
        )}
        <span className="machine" title={t("這張圖片各步驟的耗時合計（批次共用的步驟也算在內）；不含等待資源與其他圖片的步驟")}>
          {totalText(take)}
        </span>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${id}-facts`}
          onClick={() => setOpen((value) => !value)}
          className="pressable ml-auto inline-flex items-center gap-1 rounded-sm px-1 text-action-fg hover:bg-raised"
        >
          <ChevronDown aria-hidden className={cn("size-3.5 transition-[rotate] duration-(--duration-spring-snappy) ease-(--ease-spring-snappy)", open ? "rotate-180" : "")} />
          {open ? t("收起詳細") : t("詳細")}
        </button>
      </div>
      <Expand id={`${id}-facts`} open={open}>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 pb-2 text-caption">
        <dt className="text-fg-tertiary">run</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <IdText value={take.run_id} length={8} />
          <Link to={`/records/runs/${encodeURIComponent(take.run_id)}`} className="inline-flex items-center gap-1">
            <ExternalLink aria-hidden className="size-3" />
            {t("執行紀錄")}
          </Link>
        </dd>
        <dt className="text-fg-tertiary">{t("建立")}</dt>
        <dd className="text-fg-secondary">{formatTimestamp(take.created_at)}</dd>
        {snap ? (
          <>
            <dt className="text-fg-tertiary">{t("運算路由")}</dt>
            <dd className="machine truncate text-fg-secondary">{snap.route}</dd>
            <dt className="text-fg-tertiary">seed</dt>
            <dd className="machine text-fg-secondary">{`${take.seed}${snap.requested_seed === -1 ? t("（每張隨機抽出）") : snap.batch > 1 ? t("（批次 {batch} 張中的第 {batch_index} 張）", { batch: snap.batch, batch_index: snap.batch_index + 1 }) : ""}`}</dd>
            <dt className="text-fg-tertiary">prompt</dt>
            <dd className="line-clamp-3 text-fg-secondary [overflow-wrap:anywhere]">{snap.prompt}</dd>
          </>
        ) : null}
        {timings.map(([key, ms]) => (
          <div key={key} className="contents">
            <dt className="text-fg-tertiary">{stepName(key)}</dt>
            <dd className="machine text-fg-secondary">{formatMs(ms)}</dd>
          </div>
        ))}
        {take.image ? (
          <>
            <dt className="text-fg-tertiary">{t("圖片")}</dt>
            <dd className="machine text-fg-secondary">{t("{width}×{height}・{mode}{value}{value2}", { width: take.image.width, height: take.image.height, mode: take.image.mode, value: take.image.has_alpha ? t("・有透明") : "", value2: take.image_white ? t("・有白底版") : t("・沒有白底版") })}</dd>
          </>
        ) : null}
      </dl>
      </Expand>
    </div>
  );
}
