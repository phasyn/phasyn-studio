// Error boundary around a lazily loaded part of a page. When that part's code cannot be loaded (a network blip, or a
// new deployment replaced the old chunks while the page was open), only that part shows the failure and offers a
// reload; the rest of the page stays usable. Any other error is rethrown to the route's error page as before.
// React.lazy keeps a failed import, so retrying in place cannot work: reloading the page is the remedy.
import { RotateCcw } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { t } from "@/i18n";
import { isChunkLoadError } from "@/lib/chunkLoad";

interface LazyBoundaryState {
  error: unknown;
}

export class LazyBoundary extends Component<{ children: ReactNode; className?: string }, LazyBoundaryState> {
  override state: LazyBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): LazyBoundaryState {
    return { error };
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    if (!isChunkLoadError(error)) throw error instanceof Error ? error : new Error("a lazy part threw a non-Error value");
    return (
      <Callout role="alert" tone="warning" title={t("這部分沒有載入成功")} className={this.props.className}>
        <p>{t("可能是網路中斷，或服務剛更新、舊版的程式檔已不存在。請重新載入頁面。")}</p>
        <Button size="sm" variant="secondary" className="mt-1" onClick={() => { window.location.reload(); }}>
          <RotateCcw aria-hidden />
          {t("重新載入")}
        </Button>
      </Callout>
    );
  }
}
