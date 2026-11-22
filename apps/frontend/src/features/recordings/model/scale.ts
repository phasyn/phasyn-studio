// 軸刻度：bytes 以二進位單位（KiB／MiB／GiB）取整齊刻度。
const NICE = [1, 2, 2.5, 5, 10];

export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const base = 10 ** exponent;
  const nice = NICE.find((candidate) => candidate >= raw / base) ?? 10;
  return nice * base;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

export interface ByteTicks {
  ticks: number[];
  max: number;
  format: (value: number) => string;
}

export function byteTicks(maxValue: number, count = 4): ByteTicks {
  if (!(maxValue > 0) || !Number.isFinite(maxValue)) return { ticks: [0], max: 1, format: () => "0 B" };
  let k = 0;
  while (k < BYTE_UNITS.length - 1 && maxValue / 1024 ** (k + 1) >= 1) k += 1;
  const divisor = 1024 ** k;
  const unit = BYTE_UNITS[k] ?? "B";
  const step = niceStep(maxValue / divisor / count);
  const ticks: number[] = [];
  let i = 0;
  for (; i * step * divisor < maxValue; i += 1) ticks.push(i * step * divisor);
  ticks.push(i * step * divisor);
  const format = (value: number) => `${String(Number((value / divisor).toPrecision(4)))} ${unit}`;
  return { ticks, max: ticks.at(-1) ?? maxValue, format };
}
