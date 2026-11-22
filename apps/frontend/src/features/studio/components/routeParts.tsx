// 運算路由（＝元件組合）的共用顯示：用途標記（參考生成、首幀、文字、延展…）、H3 任務標記、就緒狀態、鏡頭的路由選擇清單。
// 外觀（Phasyn）：路由選項是表單選項卡（選取＝品牌細邊＋淡漸層底，不發光）；就緒點只用狀態色。
import { CircleAlert, ExternalLink, Images, Link2, LoaderCircle, TriangleAlert, Type, type LucideIcon } from "lucide-react";
import { Link } from "react-router";
import { cn } from "@/lib/cn";
import { CARD, OPTION_CARD, OPTION_IDLE, OPTION_SELECTED } from "@/components/ui/look";
import type { RoutePurpose } from "../model/providerTraits";
import { engineUnavailable, findRoute, ROUTE_MISSING, TASK_LABELS, type Engine, type RouteTask, type StudioRoute } from "../model/routes";
import { onUseText, useOnUseLoad } from "./generation/loadOnUse";
import { PURPOSE_ICON, PURPOSE_LABEL } from "./generation/modeText";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

const TASK_ICONS: Record<RouteTask, LucideIcon> = { t2va: Type, fl2va: Link2, ref2va: Images };

/** 能力標記：H3 任務名稱（mono）＋圖示；title 是中文說明。 */
export function CapabilityBadge({ task, className }: { task: RouteTask; className?: string }) {
  const Icon = TASK_ICONS[task];
  return (
    <span
      title={t("{task}：{task2}", { task, task2: TASK_LABELS[task] })}
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-raised px-2 text-caption text-fg-secondary [&_svg]:size-3", className)}
    >
      <Icon aria-hidden />
      <span className="machine">{task}</span>
      <span className="sr-only">{t("（{task}）", { task: TASK_LABELS[task] })}</span>
    </span>
  );
}

/** 用途標記：這條路線做什麼（參考生成、首幀、文字、延展、重繪、控制、表演驅動、音訊驅動）。 */
export function PurposeBadge({ purpose, className }: { purpose: RoutePurpose; className?: string }) {
  const Icon = PURPOSE_ICON[purpose];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-raised px-2 text-caption text-fg-secondary [&_svg]:size-3", className)}>
      <Icon aria-hidden />
      {PURPOSE_LABEL[purpose]}
    </span>
  );
}

export function ReadyDot({ ready, className }: { ready: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full ring-2 transition-colors duration-(--duration-base)", ready ? "bg-success ring-success/20" : "bg-warning ring-warning/20", className)}
    />
  );
}

/**
 * 路線的品質提醒（StudioRoute.caveat，例如 DiT 少於 4 步）：琥珀色警示圖示＋一行文字，放不下時截斷，完整文字在 title。
 * 每個顯示或選擇路線的地方都放在路線名稱旁邊或下一行；沒有提醒時不佔空間。
 */
export function RouteCaveatLine({ route, className }: { route: StudioRoute; className?: string }) {
  if (!route.caveat) return null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1 text-caption text-warning animate-fade-in", className)} title={route.caveat.text}>
      <TriangleAlert aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">{route.caveat.text}</span>
    </span>
  );
}

/** 路由一行狀態：就緒（綠）、使用時載入（用到才載入的元件還沒載入；藍）或未就緒＋摘要（琥珀）；完整原因在 title。 */
export function RouteReadiness({ route, className }: { route: StudioRoute; className?: string }) {
  const load = useOnUseLoad(route);
  return (
    <span className={cn("min-w-0 text-caption transition-colors duration-(--duration-base) [overflow-wrap:anywhere]", route.ready ? (load ? "text-info" : "text-success") : "text-warning", className)} title={route.problems.join("\n") || undefined}>
      {route.ready ? (load ? onUseText(load) : t("就緒")) : t("未就緒：{summary}", { summary: route.summary })}
    </span>
  );
}

/** 元件組合清單讀取中／失敗／空的說明（Inspector、渲染引擎側欄、專案對話框共用）。 */
export function RoutesUnavailable({ engine, onNavigate }: { engine: Engine; onNavigate?: () => void }) {
  const unavailable = engineUnavailable(engine);
  if (engine.status === "loading") {
    return (
      <p role="status" className="flex items-center gap-1.5 text-caption text-fg-tertiary">
        <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
        {t("讀取元件組合…")}
      </p>
    );
  }
  if (unavailable != null && unavailable !== "") {
    return (
      <p role="alert" className="flex items-start gap-1.5 text-caption text-danger [overflow-wrap:anywhere]">
        <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        {unavailable}
      </p>
    );
  }
  if (engine.routes.length > 0) return null;
  return (
    <div className={cn(CARD, "grid gap-1 px-2.5 py-2 text-caption text-fg-tertiary")}>
      <p className="text-fg-secondary">{t("還沒有可用於 Video Studio 的元件組合")}</p>
      <p>{t("Video Studio 的路線就是你保存的元件組合：要有一個文字提示輸入，以及一個成片輸出。")}</p>
      <Link to="/admin/pipelines" onClick={onNavigate} className="inline-flex items-center gap-1 justify-self-start">
        <ExternalLink aria-hidden className="size-3.5" />
        {t("到「元件修改・元件組合」建立")}
      </Link>
    </div>
  );
}

/**
 * 鏡頭的運算路由選擇：一個元件組合一個選項（名稱、能力、就緒狀態），數量與使用者設定的元件組合相同。
 * 目前的值不是任何元件組合時（已刪除或還沒選）明確顯示「路由不存在」，不默默選第一個。
 */
export function RoutePicker({ engine, value, onChange, name, currentRouteHint }: { engine: Engine; value: string; onChange: (routeId: string) => void; name: string; currentRouteHint?: string }) {
  const current = findRoute(engine.routes, value);
  return (
    <div className="grid gap-1.5">
      {engine.status === "ready" && !current ? (
        <p role="alert" className="flex items-start gap-1.5 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-caption text-warning [overflow-wrap:anywhere]">
          <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <T source={"{routeMissing}（目前的值：<0>{value}</0>）{value2}"} values={{ routeMissing: ROUTE_MISSING, value, value2: (currentRouteHint != null && currentRouteHint !== "") ? t("。{currentRouteHint}", { currentRouteHint }) : "" }} slots={[<code key="slot-0" className="machine" />]} />
          </span>
        </p>
      ) : null}
      <RoutesUnavailable engine={engine} />
      {engine.routes.map((route) => (
        <label
          key={route.id}
          title={route.label}
          className={cn(OPTION_CARD, "flex cursor-pointer items-start gap-2 px-2.5 py-2", route.id === value ? OPTION_SELECTED : OPTION_IDLE)}
        >
          <input type="radio" name={name} checked={route.id === value} onChange={() => { onChange(route.id); }} className="mt-0.5 accent-action" />
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <ReadyDot ready={route.ready} />
              <span className="min-w-0 text-data text-fg [overflow-wrap:anywhere]">{route.label}</span>
              <PurposeBadge purpose={route.purpose} />
            </span>
            <RouteReadiness route={route} />
            <RouteCaveatLine route={route} />
            {route.notes.length > 0 ? <span className="min-w-0 text-caption text-fg-secondary [overflow-wrap:anywhere]">{t("注意：{notes}", { notes: route.notes.join(t("；")) })}</span> : null}
          </span>
        </label>
      ))}
    </div>
  );
}
