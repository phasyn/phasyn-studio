// 摘要：狀態與錯誤、時間、記憶體、搬運、步數、運算量（cost）、紀錄完整度與其他指標。每個數值都經過 MetricValue。
import { CircleAlert, ClipboardList, Cpu, Footprints, Gauge, ListChecks, ScrollText, Timer } from "lucide-react";
import type { ReactNode } from "react";
import type { Recording } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { KeyValueList } from "@/components/ui/kv";
import { formatBytes, formatCount } from "@/lib/format";
import { CoverageBadge, RecordingStateBadge } from "../components/Badges";
import { CostSection } from "../components/CostSection";
import { MemorySection } from "../components/MemorySection";
import { MetricTable } from "../components/MetricValue";
import { TransferSection } from "../components/TransferSection";
import { groupMetricNames, METRIC_GROUPS, missingMetric, ungroupedMetricNames } from "../model/metrics";
import { tServer, t } from "@/i18n";

function Section({ id, icon, title, note, children }: { id: string; icon: ReactNode; title: string; note?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <h3 id={id} className="flex items-center gap-2 text-section font-semibold text-fg [&_svg]:size-4 [&_svg]:text-fg-tertiary">
        {icon}
        {title}
      </h3>
      {note ? <p className="text-caption text-fg-tertiary">{note}</p> : null}
      {children}
    </section>
  );
}

function groupRows(groupId: string, recording: Recording) {
  const group = METRIC_GROUPS.find((entry) => entry.id === groupId);
  if (!group) return { group: undefined, rows: [] };
  const metrics = recording.summary.metrics;
  return {
    group,
    rows: groupMetricNames(group, metrics).map((name) => ({ name, metric: metrics[name] ?? missingMetric(name), missing: metrics[name] === undefined })),
  };
}

const FAILED_STATES = new Set(["failed", "interrupted", "unknown", "cancelled"]);

export function SummaryTab({
  recording,
  selectedCategory,
  onSelectCategory,
  onShowErrors,
}: {
  recording: Recording;
  selectedCategory: string | null;
  onSelectCategory: (category: string) => void;
  onShowErrors: () => void;
}) {
  const { summary } = recording;
  const id = summary.recording_id;
  const time = groupRows("time", recording);
  const steps = groupRows("steps", recording);
  const device = groupRows("device", recording);
  const recorder = groupRows("recorder", recording);
  const others = ungroupedMetricNames(summary.metrics);
  const failed = FAILED_STATES.has(summary.state);

  return (
    <div className="grid gap-8">
      <Section id={`${id}-state`} icon={failed ? <CircleAlert /> : <ClipboardList />} title={t("狀態與錯誤")}>
        <div className="flex flex-wrap items-center gap-2">
          <RecordingStateBadge state={summary.state} />
          <CoverageBadge coverage={summary.coverage} />
          <Button size="sm" variant="quiet" icon={<ScrollText aria-hidden />} onClick={onShowErrors} className="pointer-coarse:min-h-11">
            {t("查看 warning／error 事件")}
          </Button>
        </div>
        {summary.notes.length > 0 ? (
          <ul className="grid gap-1.5" aria-label="summary notes">
            {summary.notes.map((note, index) => (
              <li
                key={`${index}-${note.slice(0, 24)}`}
                className={failed && index === 0 ? "rounded-r-md border-l-2 border-l-danger bg-sunken px-3 py-2 text-data text-fg" : "text-data text-fg-secondary"}
              >
                <span className="whitespace-pre-wrap break-words">{tServer(note)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-data text-fg-tertiary">{failed ? t("summary 沒有附錯誤說明；請到下方「原始事件」面板查看 error 事件與 stderr。") : t("沒有 notes。")}</p>
        )}
      </Section>

      <Section id={`${id}-time`} icon={<Timer />} title={t("時間")} note={time.group?.note}>
        <MetricTable label={t("時間指標")} rows={time.rows} />
      </Section>

      <MemorySection recording={recording} />

      <TransferSection recording={recording} selectedCategory={selectedCategory} onSelectCategory={onSelectCategory} />

      <Section id={`${id}-steps`} icon={<Footprints />} title={t("步數／前向次數")} note={steps.group?.note}>
        <MetricTable label={t("步數與前向次數")} rows={steps.rows} />
      </Section>

      <CostSection recording={recording} />

      {device.rows.length > 0 ? (
        <Section id={`${id}-device`} icon={<Cpu />} title={t("整卡取樣")} note={device.group?.note}>
          <MetricTable label={t("整卡取樣")} rows={device.rows} />
        </Section>
      ) : null}

      <Section id={`${id}-recorder`} icon={<ListChecks />} title={t("紀錄完整度與成本")} note={t("丟失與截斷照實揭露；缺段時事件與曲線會斷開，不補資料。")}>
        <KeyValueList
          items={[
            { key: "coverage", label: "coverage", value: <CoverageBadge coverage={summary.coverage} /> },
            {
              key: "dropped_events",
              label: t("丟失事件（summary）"),
              value: formatCount(summary.dropped_events),
              mono: true,
              tone: summary.dropped_events > 0 ? "warning" : "default",
            },
            {
              key: "dropped_bytes",
              label: t("丟失 bytes（summary）"),
              value: formatBytes(summary.dropped_bytes),
              mono: true,
              tone: summary.dropped_bytes > 0 ? "warning" : "default",
            },
            {
              key: "detail_truncated",
              label: t("細節截斷"),
              value: summary.detail_truncated ? t("是：已達細節上限，之後只保留聚合與 summary") : t("否"),
              tone: summary.detail_truncated ? "warning" : "default",
            },
            {
              key: "context_available",
              label: "context",
              value: summary.context_available ? t("已收到") : t("尚未收到（設定欄位為佔位，不偽補）"),
              tone: summary.context_available ? "default" : "warning",
            },
          ]}
        />
        <MetricTable label={t("紀錄器計數")} rows={recorder.rows} />
      </Section>

      {others.length > 0 ? (
        <Section id={`${id}-other`} icon={<Gauge />} title={t("其他指標")} note={t("不在常用分組內的指標（含 provider 自訂命名空間）；口徑以各列 method／scope 為準。")}>
          <MetricTable label={t("其他指標")} rows={others.map((name) => ({ name, metric: summary.metrics[name] ?? missingMetric(name) }))} />
        </Section>
      ) : null}
    </div>
  );
}
