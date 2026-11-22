// 照抄檢查的取格：在瀏覽器裡用一個不掛進畫面的 <video> 跳到指定秒數，畫進 96x54 的畫布取亮度。來源都是同源的
// /api/media（畫布不會被汙染）。每次跳轉最多等 SEEK_TIMEOUT_MS；取消（signal）或結束時一定釋放影片。
import { CHECK_HEIGHT, CHECK_WIDTH, checkTimes, copyVerdict, scorePair, toGray, type CopyResult, type GrayFrame } from "./copyCheck";

const SEEK_TIMEOUT_MS = 8000;

class FrameSource {
  private readonly video = document.createElement("video");
  private readonly canvas = document.createElement("canvas");

  constructor(url: string) {
    this.video.muted = true;
    this.video.preload = "auto";
    this.video.playsInline = true;
    this.video.src = url;
    this.canvas.width = CHECK_WIDTH;
    this.canvas.height = CHECK_HEIGHT;
  }

  private wait(event: "loadedmetadata" | "seeked", signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (error: Error | null) => {
        window.clearTimeout(timer);
        this.video.removeEventListener(event, ok);
        this.video.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const ok = () => { done(null); };
      const failed = () => { done(new Error("video could not be read")); };
      const aborted = () => { done(new DOMException("aborted", "AbortError")); };
      const timer = window.setTimeout(() => { done(new Error("video timed out")); }, SEEK_TIMEOUT_MS);
      this.video.addEventListener(event, ok);
      this.video.addEventListener("error", failed);
      signal.addEventListener("abort", aborted);
    });
  }

  async duration(signal: AbortSignal): Promise<number> {
    if (this.video.readyState < HTMLMediaElement.HAVE_METADATA) await this.wait("loadedmetadata", signal);
    return this.video.duration;
  }

  async frame(seconds: number, signal: AbortSignal): Promise<GrayFrame> {
    await this.duration(signal);
    const seeked = this.wait("seeked", signal);
    this.video.currentTime = seconds;
    await seeked;
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("canvas unavailable");
    context.drawImage(this.video, 0, 0, CHECK_WIDTH, CHECK_HEIGHT);
    return toGray(context.getImageData(0, 0, CHECK_WIDTH, CHECK_HEIGHT).data, CHECK_WIDTH, CHECK_HEIGHT);
  }

  dispose() {
    this.video.removeAttribute("src");
    this.video.load();
  }
}

/** take 與版面參考在同一時間點的相似度（參考從 referenceStart 秒起算）。 */
export async function checkCopy(takeUrl: string, referenceUrl: string, referenceStart: number, spanSeconds: number, signal: AbortSignal): Promise<CopyResult | null> {
  const take = new FrameSource(takeUrl);
  const reference = new FrameSource(referenceUrl);
  try {
    const times = checkTimes(spanSeconds, await take.duration(signal));
    const pairs = [];
    for (const seconds of times) {
      const a = await take.frame(seconds, signal);
      const b = await reference.frame(referenceStart + seconds, signal);
      pairs.push(scorePair(seconds, a, b));
    }
    return copyVerdict(pairs);
  } finally {
    take.dispose();
    reference.dispose();
  }
}
