// 專業編輯器「參考」分頁在沒有參考管理（referenceEditing）時的清單：每個參考一列（縮圖、@ 名稱、H3 標籤、檔名），
// 點一下插入到游標。外觀：列逐項進場（motion.reveal）；hover 只改底色。
import { AtSign } from "lucide-react";
import { EmptyState } from "@/components/common/EmptyState";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { ReferenceThumb } from "../references/ReferenceThumb";
import type { MentionOption } from "./mentions";

export function ReferenceList({ options, onInsert, disabled }: { options: readonly MentionOption[]; onInsert: (alias: string) => void; disabled: boolean }) {
  if (options.length === 0) {
    return (
      <EmptyState
        size="compact"
        icon={<AtSign />}
        title={t("這個鏡頭沒有參考素材")}
        description={t("在 Studio 屬性面板的「參考素材」上傳或加入圖片、影片、聲音後，這裡就能插入 @Image1、@Video1、@Audio1。")}
      />
    );
  }
  return (
    <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto p-2">
      <ul className="grid gap-0.5" aria-label={t("參考素材（{optionsCount}）", { optionsCount: options.length })}>
        {options.map((option, index) => (
          <li key={option.alias} ref={reveal(index)}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onInsert(option.alias)}
              aria-label={t("插入 @{alias}（{value}）", { alias: option.alias, value: option.name ?? t("檔案已不在素材庫") })}
              className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2.5 rounded-lg px-2 py-1.5 text-left transition-colors duration-(--duration-fast) hover:bg-raised/70 active:bg-sunken disabled:cursor-not-allowed disabled:text-fg-disabled disabled:hover:bg-transparent"
            >
              <ReferenceThumb item={option.item} kind={option.kind} className="size-14" />
              <span className="grid min-w-0">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="machine text-data text-fg">@{option.alias}</span>
                  {option.label ? <span className="machine text-caption text-fg-tertiary">→ {option.label}</span> : null}
                </span>
                <span className={cn("truncate text-caption", option.name ? "text-fg-tertiary" : "text-warning")}>{option.name ?? t("檔案已不在素材庫")}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
