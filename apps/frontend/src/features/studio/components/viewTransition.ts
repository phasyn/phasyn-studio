// 縮圖 → 監看器的共用元素轉場（View Transitions API）：點素材的 take 縮圖時，縮圖放大移動到監看器的位置。
// 不支援或找不到來源元素時直接更新。狀態在轉場回呼裡以 flushSync 同步更新（只等瀏覽器擷取舊畫面的一格，
// 不等動畫）；下一次點選會讓瀏覽器略過還沒播完的轉場。監看器的黑場框標 data-monitor-stage（Monitor.tsx）。
import { flushSync } from "react-dom";

const NAME = "studio-take-hero";

export function morphToMonitor(source: HTMLElement | null, apply: () => void): void {
  if (typeof document === "undefined" || typeof document.startViewTransition !== "function" || !source) {
    apply();
    return;
  }
  source.style.setProperty("view-transition-name", NAME);
  let target: HTMLElement | null = null;
  const transition = document.startViewTransition(() => {
    source.style.removeProperty("view-transition-name");
    // eslint-disable-next-line @eslint-react/dom-no-flush-sync -- The native view transition takes its new-layout snapshot when this callback returns.
    flushSync(apply);
    target = document.querySelector<HTMLElement>("[data-monitor-stage]");
    target?.style.setProperty("view-transition-name", NAME);
  });
  const cleanup = () => {
    source.style.removeProperty("view-transition-name");
    target?.style.removeProperty("view-transition-name");
  };
  transition.finished.then(cleanup, cleanup);
}
