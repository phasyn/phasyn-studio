import { Languages } from "lucide-react";
import { useId, useState, type ChangeEvent } from "react";
import { Select } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import { t } from "./index";
import { changeLocale, isLocale, LOCALE_NAMES, LOCALES } from "./locale";
import { getLocale } from "./store";

/**
 * 介面語言（側欄底部）：原生 select，鍵盤與螢幕閱讀器可用。選擇後存偏好並重新載入整頁
 * （有未儲存變更的頁面會由瀏覽器先詢問）；瀏覽器不允許保存偏好時不重新載入，並說明原因。
 * collapsed：只顯示圖示（透明的 select 疊在圖示上，點圖示就是打開選單）。
 */
export function LanguageSwitcher({ collapsed = false, className }: { collapsed?: boolean; className?: string }) {
  const current = getLocale();
  const id = useId();
  const [failed, setFailed] = useState(false);
  const label = t("介面語言");
  const hint = t("切換後會重新載入頁面");
  const onChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    if (!isLocale(next) || next === current) return;
    setFailed(!changeLocale(next, current));
  };
  const options = LOCALES.map((locale) => (
    <option key={locale} value={locale} lang={locale}>
      {LOCALE_NAMES[locale]}
    </option>
  ));
  const problem = failed ? (
    <p role="alert" className={collapsed ? "sr-only" : "px-3 text-caption text-warning"}>
      {t("瀏覽器不允許保存語言偏好，沒有切換")}
    </p>
  ) : null;

  if (collapsed) {
    return (
      <div className={cn("grid gap-1", className)}>
        <div
          title={t("{label}：{language}（{hint}）", { label, language: LOCALE_NAMES[current], hint })}
          className={cn(
            "pressable relative mx-auto flex size-10 items-center justify-center rounded-lg text-fg-tertiary",
            "hover:bg-raised/80 hover:text-fg focus-within:outline-2 focus-within:outline-focus",
          )}
        >
          <Languages aria-hidden className="size-4" />
          <select
            aria-label={label}
            value={current}
            onChange={onChange}
            className="absolute inset-0 cursor-pointer appearance-none rounded-lg opacity-0 outline-none"
          >
            {options}
          </select>
        </div>
        {problem}
      </div>
    );
  }

  return (
    <div className={cn("grid gap-1", className)}>
      <div className="flex h-9 items-center gap-2.5 px-3 text-caption text-fg-tertiary">
        <Languages aria-hidden className="size-3.5 shrink-0" />
        {/* The label keeps its whole word; the select (min-w-0) gives up the spare room beside its arrow instead */}
        <label htmlFor={id} className="flex-1 whitespace-nowrap">
          {label}
        </label>
        <Select id={id} compact value={current} onChange={onChange} title={hint} className="min-h-7 py-0.5 text-caption">
          {options}
        </Select>
      </div>
      {problem}
    </div>
  );
}
