// 挑選比較對象（檢視器內）：以 recording_id 加入（固定在檢視器底部），或從最近紀錄挑選（GET /api/recordings）。
// 清單只存在 URL 的 ?ids=；這裡只回報要加入的 ID，上限與去重由呼叫端與這裡共同把關。
import { Plus, Search } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { providerKind } from "@/components/workbench/kinds";
import { TEXT_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { formatTimestamp } from "@/lib/format";
import { SyntheticBadge } from "../../components/Badges";
import { LoadingBlock, QueryErrorCallout } from "../../components/Feedback";
import { reveal } from "@/components/ui/motion";
import { MAX_COMPARE } from "../../model/compareStore";
import { useRecentRecordings } from "../api";
import { t } from "@/i18n";

/** 以 recording_id 加入；錯誤與上限以文字說明（aria-describedby），送出後清空。 */
export function AddRecordingForm({ ids, onAdd }: { ids: readonly string[]; onAdd: (id: string) => void }) {
  const inputId = useId();
  const helpId = useId();
  const full = ids.length >= MAX_COMPARE;
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const id = manual.trim();
    if (!id) return setManualError(t("請輸入 recording_id"));
    if (ids.includes(id)) return setManualError(t("已在比較清單中"));
    if (full) return setManualError(t("最多 {maxCompare} 筆", { maxCompare: MAX_COMPARE }));
    setManualError(null);
    setManual("");
    onAdd(id);
  };

  return (
    <form onSubmit={submit} className="grid w-full gap-1" noValidate>
      <label htmlFor={inputId} className="text-caption text-fg-tertiary">
        {t("以 recording_id 加入")}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          compact
          id={inputId}
          value={manual}
          onChange={(event) => setManual(event.target.value)}
          placeholder="UUID"
          className="machine"
          aria-invalid={manualError ? true : undefined}
          aria-describedby={helpId}
          autoComplete="off"
        />
        <Button type="submit" size="sm" variant="primary" icon={<Plus aria-hidden />} disabled={full} title={full ? t("已達 {maxCompare} 筆上限", { maxCompare: MAX_COMPARE }) : undefined} className="pointer-coarse:min-h-11">
          {t("加入")}
        </Button>
      </div>
      <p id={helpId} className={cn("text-caption", manualError ? "text-danger" : "text-fg-tertiary")}>
        {manualError ?? (full ? t("已達 {maxCompare} 筆上限，先移除一筆。", { maxCompare: MAX_COMPARE }) : t("至少 2 筆、最多 8 筆；第 1 筆是設定差異的基準。"))}
      </p>
    </form>
  );
}

/** 最近紀錄（可依 component_id 篩選）：已在清單中或已滿時「加入」停用並說明。篩選字串由呼叫端保存，切換分頁不遺失。 */
export function RecentRecordingPicker({
  ids,
  onAdd,
  draft,
  onDraftChange,
  filter,
  onFilterChange,
}: {
  ids: readonly string[];
  onAdd: (id: string) => void;
  draft: string;
  onDraftChange: (next: string) => void;
  filter: string;
  onFilterChange: (next: string) => void;
}) {
  const filterId = useId();
  const full = ids.length >= MAX_COMPARE;
  const recent = useRecentRecordings(filter, true);
  return (
    <div className="grid content-start">
      <form
        className="flex items-end gap-2 border-b border-line-subtle px-3 py-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          onFilterChange(draft.trim());
        }}
      >
        <div className="grid min-w-0 flex-1 gap-1">
          <label htmlFor={filterId} className="text-caption text-fg-tertiary">
            {t("component_id（可留空）")}
          </label>
          <Input compact id={filterId} value={draft} onChange={(event) => onDraftChange(event.target.value)} className="machine" autoComplete="off" />
        </div>
        <Button type="submit" size="sm" icon={<Search aria-hidden />} className="pointer-coarse:min-h-11">
          {t("查詢")}
        </Button>
      </form>
      {recent.data ? (
        recent.data.items.length === 0 ? (
          <p className="px-3 py-3 text-data text-fg-tertiary">{t("沒有符合的紀錄{value}。", { value: filter ? t("（component_id＝{filter}）", { filter }) : "" })}</p>
        ) : (
          <ul aria-label={t("最近紀錄")} className="grid">
            {recent.data.items.map((item, index) => {
              const id = item.context.recording_id;
              const included = ids.includes(id);
              const kind = providerKind(item.context.provider_id);
              return (
                <li
                  key={id}
                  ref={reveal(index)}
                  className={cn("relative flex items-start gap-2 border-b border-line-subtle px-3 py-2 last:border-b-0", included
                      ? "bg-brand-gradient-soft before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-linear-to-b before:from-brand-cyan before:via-brand-blue before:to-brand-violet"
                      : "hover:bg-raised/60")}
                >
                  <kind.icon aria-hidden className={cn("mt-0.5 size-4 shrink-0", TEXT_TONE[kind.tone])} />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <code className="machine min-w-0 text-data break-all text-fg">{item.context.component_id}</code>
                      {item.context.synthetic ? <SyntheticBadge /> : null}
                    </span>
                    <span className="machine text-caption text-fg-tertiary">
                      {item.context.operation} · {formatTimestamp(item.context.created_at)} · {id.slice(0, 8)}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant={included ? "quiet" : "secondary"}
                    disabled={included || full}
                    title={included ? t("已在清單中") : full ? t("已達 {maxCompare} 筆上限", { maxCompare: MAX_COMPARE }) : undefined}
                    aria-label={t("{value} {component_id}（{id}）", { value: included ? t("已加入") : t("加入"), component_id: item.context.component_id, id: id.slice(0, 8) })}
                    onClick={() => onAdd(id)}
                    className="pointer-coarse:min-h-11"
                  >
                    {included ? t("已加入") : t("加入")}
                  </Button>
                </li>
              );
            })}
          </ul>
        )
      ) : recent.error ? (
        <div className="p-3">
          <QueryErrorCallout error={recent.error} title={t("最近紀錄讀取失敗")} onRetry={() => void recent.refetch()} retrying={recent.isFetching} />
        </div>
      ) : (
        <LoadingBlock label={t("讀取最近紀錄…")} rows={5} className="px-3" />
      )}
    </div>
  );
}
