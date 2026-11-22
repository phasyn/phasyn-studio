// Error boundary around a lazily loaded part of a toolbar row (the Studio toolbar's face-swap launcher, the prompt
// toolbar's advisor badge). When its code cannot be loaded (a network blip, or a deployment replaced the chunks while
// the page was open), a small warning button that reloads the page takes its place: LazyBoundary's callout does not fit
// a toolbar row. Any other error goes on to the route's error page.
import { TriangleAlert } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { isChunkLoadError } from "@/lib/chunkLoad";
import { t } from "@/i18n";

export class ToolbarPartBoundary extends Component<{ children: ReactNode; className?: string }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(error: unknown): { failed: boolean } {
    if (!isChunkLoadError(error)) throw error instanceof Error ? error : new Error("a toolbar part threw a non-Error value");
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    const label = [t("這部分沒有載入成功"), t("重新載入")].join("\n");
    return (
      <Button
        size="sm"
        variant="secondary"
        icon={<TriangleAlert aria-hidden className="text-warning" />}
        title={label}
        aria-label={label}
        onClick={() => { window.location.reload(); }}
        className={this.props.className ?? "shrink-0"}
      />
    );
  }
}
