
import type { Port } from "@/api/generated/contracts";
import { typeTone } from "@/components/workbench/kinds";
import { CHIP_TONE, DOT_TONE } from "@/components/workbench/tones";
import { cn } from "@/lib/cn";
import { tServer, t } from "@/i18n";
import { reveal } from "@/components/ui/motion";

/** 元件的輸入或輸出接點（Inspector 的「輸入／輸出」分頁）：名稱、型別（類型色）、必填、傳輸方式與說明。 */
export function PortList({ ports, direction }: { ports: readonly Port[]; direction: "input" | "output" }) {
  if (ports.length === 0) {
    return <p className="px-3 py-4 text-caption text-fg-tertiary">{direction === "input" ? t("這個元件沒有輸入接點。") : t("這個元件沒有輸出接點。")}</p>;
  }
  return (
    <ul aria-label={direction === "input" ? t("輸入接點") : t("輸出接點")} className="grid">
      {ports.map((port, index) => {
        const tone = typeTone(port.type_id);
        return (
          <li
            key={port.name}
            ref={reveal(index)}
            className="grid gap-1 border-b border-line-subtle px-3 py-2.5 last:border-b-0"
          >
            <div className="flex min-w-0 items-center gap-2">
              <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_TONE[tone])} />
              <code className="machine min-w-0 truncate text-data text-fg">{port.name}</code>
              <span className="ml-auto shrink-0 text-caption text-fg-tertiary">{port.required ? t("必填") : t("選填")}</span>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-4">
              <span className={cn("machine max-w-full truncate rounded-sm border px-1.5 text-caption", CHIP_TONE[tone])} title={port.type_id}>
                {port.type_id}
              </span>
              <span className="machine text-caption text-fg-tertiary">{port.transport}</span>
            </div>
            {port.description ? <p className="pl-4 text-caption [overflow-wrap:anywhere] text-fg-secondary">{tServer(port.description)}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
