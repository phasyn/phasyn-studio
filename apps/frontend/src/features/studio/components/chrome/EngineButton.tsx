// The toolbar's 「渲染引擎」: one button for the engine's state and for fixing it. A readiness dot and the label; when the
// current shot's route cannot render (a component stopped, the route missing, the catalog unreadable) the button turns
// amber and its tooltip and accessible name say why (the same sentence as the render button's disabled reason, from the
// same preflight). Pressing it then opens the sheet on 元件 for that route, where the stopped components are started;
// while everything is ready it opens on the tab chosen last. It replaces the separate 「開啟渲染引擎」 fix button that
// used to sit beside 「渲染鏡頭」. While the catalog is still loading the dot is amber but the button stays neutral, so
// every page load does not flash a warning.
import type { StudioShot } from "@/api/generated/contracts";
import { Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { useRenderBlock } from "../../hooks/useRenderBlock";
import { useStudio } from "../../studioContext";
import { showEngine } from "../generation/engineView";
import { ReadyDot } from "../routeParts";
import { useCurrentRoute, type EngineSummary } from "./currentRoute";
import { t } from "@/i18n";

/** The amber tone of an engine button that needs attention (Image Studio's 生成引擎 uses the same). */
export const ENGINE_ATTENTION_CLASS = "border-warning/45 bg-warning/8 text-warning hover:border-warning/70 hover:bg-warning/12";

interface Attention {
  /** Why the current shot cannot render, one reason per line. */
  reason: string;
  /** The route's components are what is missing: open 元件 (otherwise 路線, to choose another route). */
  components: boolean;
}

interface ViewProps {
  summary: EngineSummary;
  attention: Attention | null;
  iconOnly: boolean;
}

function EngineButtonView({ summary, attention, iconOnly }: ViewProps) {
  const { setEngineOpen } = useStudio();
  const { route, engine } = useCurrentRoute();
  const warn = attention !== null && engine.status !== "loading";
  const open = () => {
    if (warn) showEngine({ tab: attention.components ? "components" : "routes", routeId: null }, setEngineOpen);
    else setEngineOpen(true);
  };
  const title = warn
    ? t("渲染引擎未就緒：按一下開啟，啟動需要的元件\n{reason}", { reason: attention.reason })
    : t("查看與啟動元件組合需要的元件\n目前鏡頭的路由：{title}", { title: summary.title });
  return (
    <Button size="md" variant="secondary" onClick={open} title={title} className={cn("min-w-0 shrink", warn && ENGINE_ATTENTION_CLASS)}>
      <ReadyDot ready={summary.ready && attention === null} />
      {iconOnly ? (
        <>
          <Cpu aria-hidden />
          <span className="sr-only">{t("渲染引擎")}</span>
        </>
      ) : (
        <span data-fit-label className="truncate">
          {t("渲染引擎")}
        </span>
      )}
      <span className="sr-only">
        {warn
          ? t("：{reason}", { reason: attention.reason.replaceAll("\n", t("；")) })
          : `${route ? t("{label}・", { label: route.label }) : ""}${summary.text}`}
      </span>
    </Button>
  );
}

/** With a selected shot: the render button's own preflight decides (lanes included), so both say the same thing. */
function ShotEngineButton({ shot, summary, iconOnly }: { shot: StudioShot; summary: EngineSummary; iconOnly: boolean }) {
  const { route } = useCurrentRoute();
  const preflight = useRenderBlock(shot).preflight;
  const attention: Attention | null =
    preflight?.kind === "engine"
      ? { reason: preflight.items.length > 0 ? preflight.items.join("\n") : preflight.text, components: route !== null && !route.ready }
      : summary.ready
        ? null
        : { reason: summary.title || summary.text, components: route !== null };
  return <EngineButtonView summary={summary} attention={attention} iconOnly={iconOnly} />;
}

/** 工具列的「渲染引擎」：狀態點＋文字；未就緒時轉成琥珀色、說明原因，按下開到要啟動的元件。 */
export function EngineButton({ summary, iconOnly }: { summary: EngineSummary; iconOnly: boolean }) {
  const { shot, route } = useCurrentRoute();
  if (shot) return <ShotEngineButton shot={shot} summary={summary} iconOnly={iconOnly} />;
  const attention = summary.ready ? null : { reason: summary.title || summary.text, components: route !== null };
  return <EngineButtonView summary={summary} attention={attention} iconOnly={iconOnly} />;
}
