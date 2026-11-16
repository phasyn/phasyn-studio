// The Prompt tab's plugin badge in the editor toolbar (it replaces the block of plugin chips that stood above the
// prompt): 插件 5 with a check when every rule holds, 插件 5 · 3 項不符 in the warning tone when not, neutral while the
// prompt is still empty or the registry is being read. It opens a panel with what does not hold (the same list as the
// Plugins tab's check) and a way to that tab. A toolbar too narrow for its words keeps what matters: 5 ✓, or ⚠ 3 不符.
// Motion: the label fades when the state changes; the panel pops in like the other toolbar panels.
import { Check, LoaderCircle, Puzzle, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { useId, useState } from "react";
import type { StudioShot } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { useChangeFade } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { TOOL, toolPadding, useToolbarFit } from "../../prompt/toolbar/fit";
import { ToolPopover } from "../../prompt/toolbar/ToolPopover";
import { PromptPluginStatus } from "../PromptPlugins";
import type { PluginBadgeState } from "./usePluginBadge";

function badgeName(badge: PluginBadgeState): string {
  const status =
    badge.state === "loading"
      ? t("讀取插件登錄表…")
      : badge.state === "empty"
        ? t("{count} 個插件項目，prompt 寫了以後才檢查", { count: badge.count })
        : badge.state === "ok"
          ? t("{count} 個插件項目都符合", { count: badge.count })
          : t("{count} 項不符合，這個鏡頭不能渲染", { count: badge.failed });
  return t("插件檢查：{status}", { status });
}

/** While the prompt is empty: why the rules wait, and the problems that do not depend on the text. */
function EmptyPromptCheck({ problems }: { problems: readonly string[] }) {
  return (
    <div className="grid gap-1.5 px-1">
      <p className="text-data text-fg-secondary">{t("prompt 還是空的：寫了以後才檢查寫法規則。")}</p>
      {problems.length > 0 ? (
        <ul aria-label={t("不符合的項目")} className="grid gap-1">
          {problems.map((problem) => (
            <li key={problem} className="flex min-w-0 items-start gap-1.5 text-data text-warning">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{problem}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function PluginBadge({ shot, badge, onOpenPlugins }: { shot: StudioShot; badge: PluginBadgeState; onOpenPlugins: () => void }) {
  const id = useId();
  const fit = useToolbarFit();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const fade = useChangeFade<HTMLSpanElement>(badge.key);
  const name = badgeName(badge);
  const failing = badge.state === "fail";
  const close = (restoreFocus: boolean) => {
    if (restoreFocus && anchor?.isConnected) anchor.focus();
    setAnchor(null);
  };
  return (
    <span className="flex shrink-0 items-center">
      <Button
        size="sm"
        variant="quiet"
        icon={<Puzzle aria-hidden />}
        aria-label={name}
        title={name}
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        aria-controls={anchor ? id : undefined}
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
        className={cn(TOOL, toolPadding(fit), failing && "bg-warning/10 text-warning hover:bg-warning/15 hover:text-warning")}
      >
        <span ref={fade} aria-hidden className="flex items-center gap-1">
          {fit.statusLabel ? <span>{t("插件")}</span> : null}
          {fit.statusLabel || !failing ? <span className="machine">{badge.count}</span> : null}
          {badge.state === "loading" ? <LoaderCircle className="animate-spin text-fg-tertiary" /> : null}
          {badge.state === "ok" ? <Check className="text-success" /> : null}
          {failing && fit.statusLabel ? <span>· {t("{count} 項不符", { count: badge.failed })}</span> : null}
          {failing && !fit.statusLabel ? (
            <>
              <TriangleAlert />
              <span>{t("{count} 不符", { count: badge.failed })}</span>
            </>
          ) : null}
        </span>
      </Button>
      {anchor ? (
        <ToolPopover id={id} anchor={anchor} label={t("插件檢查")} width={340} onClose={close}>
          <div className="grid gap-2.5 p-1">
            <p className="flex items-center gap-2 px-1 text-data font-semibold text-fg">
              <Puzzle aria-hidden className="size-4 text-brand-cyan" />
              {t("插件檢查")}
              <span className="machine text-caption font-normal text-fg-tertiary">{badge.count}</span>
            </p>
            {badge.state === "loading" ? (
              <p role="status" className="flex items-center gap-2 px-1 text-data text-fg-secondary">
                <LoaderCircle aria-hidden className="size-4 text-brand-cyan animate-spin" />
                {t("讀取插件登錄表…")}
              </p>
            ) : shot.prompt.trim() === "" ? (
              <EmptyPromptCheck problems={badge.problems} />
            ) : (
              <PromptPluginStatus shot={shot} />
            )}
            <Button
              size="sm"
              variant="secondary"
              icon={<SlidersHorizontal aria-hidden />}
              className="justify-self-start"
              onClick={() => {
                setAnchor(null);
                onOpenPlugins();
              }}
            >
              {t("在「插件」分頁調整")}
            </Button>
          </div>
        </ToolPopover>
      ) : null}
    </span>
  );
}
