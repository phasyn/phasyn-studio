// 照抄檢查：版面參考壓得住看鏡頭，靠的是讓 take 跟著參考的構圖走，跟太緊就成了照抄。
// 這裡在同一時間點（片頭、中段、參考結束前）各取 take 與參考的一格，縮成 96x54 灰階後比兩件事：
//  - 邊緣圖相關（Sobel 梯度強度的 Pearson 相關）：輪廓與站位重疊多少，畫風與顏色不同也量得到；
//  - SSIM（8x8 視窗、步長 4 的平均）：明暗結構像不像。
// 取三個時間點中最像的一點下判斷。門檻還沒有用人工標註校準，所以結果只是提醒，
// 數字只放在說明裡。純函式；取格在 ./frames。
export const CHECK_WIDTH = 96;
export const CHECK_HEIGHT = 54;

/** 尚未校準的門檻（邊緣圖相關）。 */
export const COPY_THRESHOLDS = { copied: 0.8, close: 0.4 } as const;

export type CopyVerdict = "copied" | "close" | "loose";

export interface GrayFrame {
  width: number;
  height: number;
  /** 0–1 的亮度，列優先。 */
  data: Float32Array;
}

/** RGBA 像素 → 亮度（Rec. 601）。 */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): GrayFrame {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i += 1) {
    const o = i * 4;
    data[i] = (0.299 * (rgba[o] ?? 0) + 0.587 * (rgba[o + 1] ?? 0) + 0.114 * (rgba[o + 2] ?? 0)) / 255;
  }
  return { width, height, data };
}

function at(frame: GrayFrame, x: number, y: number): number {
  const cx = Math.min(frame.width - 1, Math.max(0, x));
  const cy = Math.min(frame.height - 1, Math.max(0, y));
  return frame.data[cy * frame.width + cx] ?? 0;
}

/** Sobel 梯度強度。 */
export function edges(frame: GrayFrame): Float32Array {
  const out = new Float32Array(frame.width * frame.height);
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const gx = at(frame, x + 1, y - 1) + 2 * at(frame, x + 1, y) + at(frame, x + 1, y + 1) - at(frame, x - 1, y - 1) - 2 * at(frame, x - 1, y) - at(frame, x - 1, y + 1);
      const gy = at(frame, x - 1, y + 1) + 2 * at(frame, x, y + 1) + at(frame, x + 1, y + 1) - at(frame, x - 1, y - 1) - 2 * at(frame, x, y - 1) - at(frame, x + 1, y - 1);
      out[y * frame.width + x] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/** Pearson 相關；任一邊沒有變化（全平）時為 0。 */
export function correlation(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    ma += a[i] ?? 0;
    mb += b[i] ?? 0;
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i += 1) {
    const da = (a[i] ?? 0) - ma;
    const db = (b[i] ?? 0) - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

const C1 = 0.01 ** 2;
const C2 = 0.03 ** 2;
const WINDOW = 8;
const STRIDE = 4;

/** 平均 SSIM（8x8 視窗、步長 4）；兩格大小不同時為 0。 */
export function ssim(a: GrayFrame, b: GrayFrame): number {
  if (a.width !== b.width || a.height !== b.height || a.width < WINDOW || a.height < WINDOW) return 0;
  let sum = 0;
  let count = 0;
  const n = WINDOW * WINDOW;
  for (let y = 0; y + WINDOW <= a.height; y += STRIDE) {
    for (let x = 0; x + WINDOW <= a.width; x += STRIDE) {
      let ma = 0;
      let mb = 0;
      for (let j = 0; j < WINDOW; j += 1) for (let i = 0; i < WINDOW; i += 1) {
        ma += at(a, x + i, y + j);
        mb += at(b, x + i, y + j);
      }
      ma /= n;
      mb /= n;
      let va = 0;
      let vb = 0;
      let cov = 0;
      for (let j = 0; j < WINDOW; j += 1) for (let i = 0; i < WINDOW; i += 1) {
        const da = at(a, x + i, y + j) - ma;
        const db = at(b, x + i, y + j) - mb;
        va += da * da;
        vb += db * db;
        cov += da * db;
      }
      va /= n - 1;
      vb /= n - 1;
      cov /= n - 1;
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      count += 1;
    }
  }
  return count > 0 ? sum / count : 0;
}

export interface PairScore {
  /** 比較的時間點（秒，從片頭算）。 */
  seconds: number;
  edge: number;
  ssim: number;
}

export interface CopyResult {
  verdict: CopyVerdict;
  /** 最像的一點。 */
  worst: PairScore;
  pairs: PairScore[];
}

/** 一組同時間點的格。 */
export function scorePair(seconds: number, take: GrayFrame, reference: GrayFrame): PairScore {
  return { seconds, edge: correlation(edges(take), edges(reference)), ssim: ssim(take, reference) };
}

/** 各時間點的分數 → 判斷（取邊緣圖最像的一點）。沒有任何一點 → null。 */
export function copyVerdict(pairs: readonly PairScore[]): CopyResult | null {
  const worst = pairs.reduce<PairScore | null>((best, pair) => (!best || pair.edge > best.edge ? pair : best), null);
  if (!worst) return null;
  const verdict: CopyVerdict = worst.edge >= COPY_THRESHOLDS.copied ? "copied" : worst.edge >= COPY_THRESHOLDS.close ? "close" : "loose";
  return { verdict, worst, pairs: [...pairs] };
}

/**
 * 比較的時間點：只取參考的中段（不超過 take 的長度）。片頭不比：每個用了參考的 take 開頭幾乎都照著參考起手，
 * 會把「鬆散」也判成照抄（門檻是暫定值，待人工標註驗證）。
 */
export function checkTimes(spanSeconds: number, takeSeconds: number): number[] {
  const end = Math.min(spanSeconds, takeSeconds);
  if (!(end > 0.6)) return [];
  return [Math.round((end / 2) * 100) / 100];
}
