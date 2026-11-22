// The ambient backdrop of brand-moment screens (page-level loading, page-level empty states, the Video Studio start
// screens, not-found and full-page route errors): the static deep-space gradient at once, then the three.js aurora
// (aurora/AuroraScene, loaded lazily) on top of it. Decorative: aria-hidden and no pointer input; the content stays
// above it. The scene runs only while the page is visible and the backdrop is on screen. A machine without fast WebGL 2
// gets the animated low tier; without WebGL 2 the static gradient stays, and a failed chunk or a lost context switches
// to it (the cause is logged). Never use it in data-dense regions (tables, forms, records, inspectors).
import { Component, lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import type { AuroraTier } from "./aurora/AuroraScene";

const AuroraScene = lazy(() => import("./aurora/AuroraScene"));

type Capability = AuroraTier | "none";
let probed: Capability | undefined;

function release(context: WebGL2RenderingContext | null): void {
  context?.getExtension("WEBGL_lose_context")?.loseContext();
}

/** Probed once per page (the browser caps live contexts): fast WebGL 2 → high, slow (software) → low, none → static. */
function capability(): Capability {
  if (probed) return probed;
  probed = "none";
  try {
    const fast = document.createElement("canvas").getContext("webgl2", { failIfMajorPerformanceCaveat: true });
    if (fast) {
      release(fast);
      const nav = navigator as Navigator & { deviceMemory?: number };
      probed = (nav.hardwareConcurrency || 8) <= 4 || (nav.deviceMemory ?? 8) <= 4 ? "low" : "high";
    } else {
      const slow = document.createElement("canvas").getContext("webgl2");
      if (slow) probed = "low";
      release(slow);
    }
  } catch (error) {
    console.warn("Aurora backdrop: WebGL 2 probe failed", error);
  }
  return probed;
}

class SceneBoundary extends Component<{ children: ReactNode; onError: (reason: string) => void }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error instanceof Error ? error.message : String(error));
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || document.visibilityState === "visible");
  useEffect(() => {
    const update = () => { setVisible(document.visibilityState === "visible"); };
    document.addEventListener("visibilitychange", update);
    return () => { document.removeEventListener("visibilitychange", update); };
  }, []);
  return visible;
}

export function AuroraBackdrop({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tier] = useState<Capability>(() => (typeof document === "undefined" ? "none" : capability()));
  const [failed, setFailed] = useState(false);
  const [onscreen, setOnscreen] = useState(true);
  const visible = usePageVisible();

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setOnscreen(entry.isIntersecting);
    });
    observer.observe(node);
    return () => { observer.disconnect(); };
  }, []);

  const fail = useCallback((reason: string) => {
    console.warn(`Aurora backdrop: showing the static backdrop (${reason})`);
    setFailed(true);
  }, []);

  return (
    <div ref={ref} aria-hidden className={cn("pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-canvas", className)}>
      <div className="absolute inset-0 bg-[image:var(--gradient-space)]" />
      {tier !== "none" && !failed ? (
        <SceneBoundary onError={fail}>
          <Suspense fallback={null}>
            <AuroraScene tier={tier} active={visible && onscreen} onLost={fail} />
          </Suspense>
        </SceneBoundary>
      ) : null}
    </div>
  );
}
