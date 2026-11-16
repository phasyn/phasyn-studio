import {
  Activity,
  Ban,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
  CircleSlash,
  CircleX,
  Clock,
  Copy,
  LoaderCircle,
  Square,
  TriangleAlert,
  Unplug,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import type { BadgeTone } from "@/components/ui/badge";
import { t } from "@/i18n";

export type StatusKind = "component" | "run" | "step" | "directory" | "recorder";

export interface StatusSpec {
  label: string;
  tone: BadgeTone;
  icon: LucideIcon;
}

const SPECS: Record<StatusKind, Record<string, StatusSpec>> = {
  component: {
    stopped: { label: t("已停止"), tone: "neutral", icon: Square },
    loading: { label: t("載入中"), tone: "info", icon: LoaderCircle },
    ready: { label: t("就緒"), tone: "success", icon: CircleCheck },
    busy: { label: t("呼叫中"), tone: "action", icon: Activity },
    stopping: { label: t("停止中"), tone: "info", icon: CirclePause },
    error: { label: t("錯誤"), tone: "danger", icon: CircleAlert },
  },
  run: {
    running: { label: t("執行中"), tone: "info", icon: LoaderCircle },
    succeeded: { label: t("成功"), tone: "success", icon: CircleCheck },
    failed: { label: t("失敗"), tone: "danger", icon: CircleX },
    cancelled: { label: t("已取消"), tone: "neutral", icon: Ban },
    interrupted: { label: t("已中斷"), tone: "warning", icon: TriangleAlert },
  },
  step: {
    pending: { label: t("待執行"), tone: "neutral", icon: CircleDashed },
    waiting: { label: t("等待資源"), tone: "neutral", icon: Clock },
    running: { label: t("執行中"), tone: "info", icon: LoaderCircle },
    succeeded: { label: t("成功"), tone: "success", icon: CircleCheck },
    failed: { label: t("失敗"), tone: "danger", icon: CircleX },
    cancelled: { label: t("已取消"), tone: "neutral", icon: Ban },
    interrupted: { label: t("已中斷"), tone: "warning", icon: TriangleAlert },
    skipped: { label: t("已略過"), tone: "neutral", icon: CircleSlash },
  },
  directory: {
    online: { label: t("線上"), tone: "success", icon: Wifi },
    offline: { label: t("離線（資料過時）"), tone: "warning", icon: Unplug },
    duplicate_node_id: { label: t("node_id 重複"), tone: "danger", icon: Copy },
  },
  recorder: {
    ok: { label: t("紀錄正常"), tone: "neutral", icon: CircleDot },
    degraded: { label: t("紀錄降級"), tone: "warning", icon: TriangleAlert },
    off: { label: t("紀錄關閉"), tone: "neutral", icon: CircleSlash },
    unknown: { label: t("紀錄狀態未知"), tone: "neutral", icon: CircleDashed },
  },
};

export function statusSpec(kind: StatusKind, value: string): StatusSpec {
  return SPECS[kind][value] ?? { label: t("未知狀態（{value}）", { value }), tone: "neutral", icon: CircleDashed };
}
