// 格式化：先選規則、看前後差異，按「套用」才改 prompt（不會默默改字）。
import { withOccurrenceKeys } from "@/lib/occurrenceKeys";
import { RemoveFormatting } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { OPTION_CARD, OPTION_IDLE, OPTION_SELECTED } from "@/components/ui/look";
import { collapseRows, previewRows, type InlinePart, type PreviewRow } from "@/lib/textDiff";
import { DEFAULT_FORMAT_OPTIONS, formatPrompt, formatSummary, type FormatOptions, type TimelineMode } from "./format";
import { t } from "@/i18n";

const TIMELINE_CHOICES: { value: TimelineMode; label: string; description: string }[] = [
  { value: "keep", label: t("保持原樣"), description: t("時間標題不轉換。") },
  { value: "sequential", label: t("轉成官方分鏡 [Shot 1]、[Shot 2] At 00:01.500,"), description: t("每個時段是一次切鏡：第一鏡不加時間，之後寫切入時間（官方 Base／Full-Reference 指南）。") },
  { value: "single", label: t("轉成 [Shot 1, 00:00.000-00:01.500]"), description: t("全部算同一個連續鏡頭內的時段（官方加速 LoRA 範例 predict_ref2v.py 的寫法；MiniMax 指南沒有記載）。") },
];

function visible(text: string): string {
  return text.replace(/ /g, "·").replace(/\t/g, "→").replace(/\u3000/g, "□");
}

function Part({ part }: { part: InlinePart }) {
  if (part.op === "equal") return <span>{part.text}</span>;
  const shown = part.text.trim() === "" ? visible(part.text) : part.text;
  return part.op === "delete" ? (
    <del className="rounded-sm bg-danger/15 text-danger decoration-danger/70">
      <span className="sr-only">{t("（刪除：")}</span>
      {shown}
      <span className="sr-only">{t("）")}</span>
    </del>
  ) : (
    <ins className="rounded-sm bg-success/15 text-success no-underline">
      <span className="sr-only">{t("（新增：")}</span>
      {shown}
      <span className="sr-only">{t("）")}</span>
    </ins>
  );
}

function Row({ row }: { row: PreviewRow }) {
  const sign = row.kind === "removed" ? "−" : row.kind === "added" ? "+" : row.kind === "changed" ? "±" : " ";
  return (
    <div className={cn("grid grid-cols-[1.25rem_minmax(0,1fr)] gap-1 px-2 py-0.5", row.kind === "removed" && "bg-danger/8", row.kind === "added" && "bg-success/8")}>
      <span aria-hidden className="machine text-fg-tertiary select-none">
        {sign}
      </span>
      <span className={cn("min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]", row.kind === "same" ? "text-fg-tertiary" : "text-fg")}>
        {row.kind === "changed" ? (
          withOccurrenceKeys(row.parts, (part) => JSON.stringify(part)).map(({ item: part, key }) => <Part key={key} part={part} />)
        ) : row.kind === "removed" ? (
          <del className="text-danger">{row.text.length > 0 ? row.text : t("（空行）")}</del>
        ) : row.kind === "added" ? (
          <ins className="text-success no-underline">{row.text.length > 0 ? row.text : t("（空行）")}</ins>
        ) : (
          row.text || " "
        )}
      </span>
    </div>
  );
}

export function FormatDialog({
  open,
  onOpenChange,
  value,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onApply: (next: string, summary: string) => void;
}) {
  const id = useId();
  const [options, setOptions] = useState<FormatOptions>(DEFAULT_FORMAT_OPTIONS);
  const result = useMemo(() => formatPrompt(value, options), [value, options]);
  const rows = useMemo(() => collapseRows(previewRows(value, result.text)), [value, result.text]);
  const changed = result.text !== value;
  const toggle = (key: "markdown" | "whitespace" | "cjk") => { setOptions((current) => ({ ...current, [key]: !current[key] })); };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent wide aria-describedby={`${id}-description`}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RemoveFormatting aria-hidden className="size-4 text-brand-cyan" />
            {t("格式化 prompt")}
          </DialogTitle>
          <DialogDescription id={`${id}-description`}>{t("先選要套用的規則並確認差異；按「套用」才會修改 prompt，套用後也可以復原。")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-4">
          <div className="grid gap-x-6 md:grid-cols-2">
            <div className="grid content-start">
              <Checkbox
                id={`${id}-markdown`}
                checked={options.markdown}
                onChange={() => { toggle("markdown"); }}
                label={t("移除 Markdown 標記")}
                description={t("**粗體**、__粗體__、*斜體*、`程式碼`、``` 與行首 #：H3 會把這些符號當成文字。")}
              />
              <Checkbox id={`${id}-whitespace`} checked={options.whitespace} onChange={() => { toggle("whitespace"); }} label={t("整理空白與空行")} description={t("去掉行尾空白、連續空行只留一行、去掉頭尾空行。")} />
              <Checkbox
                id={`${id}-cjk`}
                checked={options.cjk}
                onChange={() => { toggle("cjk"); }}
                label={t("全形空白與標點旁空白")}
                description={t("行內全形空白改半形、連續空白合併、全形標點旁的空白移除；行首縮排與中英文之間的空白不變。")}
              />
            </div>
            <fieldset className="grid content-start gap-1.5">
              <legend className="pb-1 text-body text-fg">{t("時間標題（例如 **0.0–1.5 秒：**）")}</legend>
              {TIMELINE_CHOICES.map((choice) => (
                <label aria-label={[choice.label, choice.description].join(" ")} key={choice.value} className={cn(OPTION_CARD, "flex cursor-pointer items-start gap-3 px-3 py-2 text-body", options.timeline === choice.value ? OPTION_SELECTED : OPTION_IDLE)}>
                  <input
                    type="radio"
                    name={`${id}-timeline`}
                    checked={options.timeline === choice.value}
                    onChange={() => { setOptions((current) => ({ ...current, timeline: choice.value })); }}
                    className="mt-1 size-4 shrink-0 accent-action"
                  />
                  <span className="min-w-0">
                    <span className="machine text-data text-fg">{choice.label}</span>
                    <span className="block text-caption text-fg-tertiary">{choice.description}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
          <section aria-labelledby={`${id}-preview`} className="grid min-w-0 gap-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id={`${id}-preview`} className="text-data font-semibold text-fg">
                {t("差異預覽")}
              </h3>
              <p className="text-caption text-fg-tertiary">{formatSummary(result.counts)}</p>
            </div>
            <div  /* eslint-disable-line jsx-a11y-x/no-noninteractive-tabindex -- Keyboard users can focus this scrollable region and scroll its overflow. */ tabIndex={0} role="region" aria-label={t("格式化前後差異")} className="max-h-[45vh] min-w-0 overflow-y-auto rounded-lg border border-line-subtle bg-sunken py-1 text-data leading-6">
              {changed ? (
                withOccurrenceKeys(rows, (item) => JSON.stringify(item)).map(({ item: item, key }) =>
                  item.type === "skip" ? (
                    <p key={key} className="px-2 py-0.5 text-caption text-fg-tertiary">
                      {t("… 未變更 {count} 行 …", { count: item.count })}
                    </p>
                  ) : (
                    <Row key={key} row={item.row} />
                  ),
                )
              ) : (
                <p className="px-3 py-4 text-caption text-fg-tertiary">{t("用目前的規則格式化不會改變任何文字。")}</p>
              )}
            </div>
          </section>
        </DialogBody>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="secondary">{t("取消")}</Button>
          </DialogClose>
          <Button
            variant="primary"
            icon={<RemoveFormatting aria-hidden />}
            disabled={!changed}
            onClick={() => {
              onApply(result.text, t("已格式化：{counts}", { counts: formatSummary(result.counts) }));
              onOpenChange(false);
            }}
          >
            {changed ? t("套用格式化") : t("沒有需要調整的地方")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
