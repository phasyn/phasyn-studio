import { Search } from "lucide-react";
import { Input } from "@/components/ui/controls";

/** 左欄的搜尋框（放大鏡圖示＋精簡輸入框）。 */
export function SearchBox({ value, onChange, placeholder, label }: { value: string; onChange: (value: string) => void; placeholder: string; label: string }) {
  return (
    <div className="relative min-w-0 flex-1">
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-fg-tertiary" />
      <Input
        compact
        type="search"
        value={value}
        onChange={(event) => { onChange(event.target.value); }}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        className="pl-8"
      />
    </div>
  );
}
