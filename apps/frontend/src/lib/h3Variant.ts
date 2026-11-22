// H3 的 checkpoint variant（runtimes/h3 config.py：fl2va、ref2va）。元件實際用哪個 variant 由它的設定決定；
// Studio 的運算路由與「從範本建立元件組合」都要依它挑 DiT，所以放在共用的 lib（功能目錄之間不直接互相引用）。
import type { ComponentDescriptor } from "@/api/generated/contracts";
import { isRecord } from "@/lib/json";

export const VARIANT_FL2VA = "fl2va";
export const VARIANT_REF2VA = "ref2va";

/**
 * H3 元件實際用的 checkpoint variant：已載入時看 loaded 設定（正在跑的就是它），否則看保存設定；
 * 都沒寫時是元件預設 fl2va（runtimes/h3 config.py ROLE_DEFAULTS）。
 */
export function componentVariant(component: ComponentDescriptor): string {
  const settings: unknown = component.settings;
  const pick = (load: unknown): string | null => {
    const options = isRecord(load) ? load["provider_options"] : null;
    return isRecord(options) && typeof options["variant"] === "string" ? options["variant"] : null;
  };
  if (!isRecord(settings)) return VARIANT_FL2VA;
  const stored = isRecord(settings["stored"]) ? settings["stored"]["load"] : null;
  return pick(settings["loaded"]) ?? pick(stored) ?? VARIANT_FL2VA;
}
