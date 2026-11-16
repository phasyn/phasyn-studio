// 開啟插件管理視窗的按鈕（鏡頭「插件」分頁頂端）：有圖示、文字與已安裝的數量。它是入口，不是這個分頁的主要動作，
// 所以用次要按鈕的外觀（主要按鈕的漸層留給「渲染鏡頭」這類動作）。
import { Puzzle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { openPluginManager } from "../manager/managerOpen";
import type { PluginRegistry } from "../model/registry";

export function ManagePluginsButton({ registry, className }: { registry: PluginRegistry; className?: string }) {
  const count = registry.list?.items.length ?? null;
  return (
    <Button
      variant="secondary"
      onClick={() => openPluginManager({ tab: "installed" })}
      title={t("安裝、檢視、匯出與移除插件")}
      className={cn("h-10 w-full justify-start gap-2.5 rounded-lg px-2.5 text-left", className)}
    >
      <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-md bg-brand-soft text-brand-cyan [&_svg]:size-3.5">
        <Puzzle />
      </span>
      <span className="min-w-0 flex-1 truncate text-body font-medium">{t("管理插件…")}</span>
      {count !== null ? (
        <span className="machine inline-flex min-w-6 items-center justify-center rounded-full bg-raised px-1.5 text-caption leading-5 text-fg-tertiary">{count}</span>
      ) : null}
    </Button>
  );
}
