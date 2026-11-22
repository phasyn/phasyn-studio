// The characters of the 逐鏡描述 dialog: each <Subject N> with its reference picture and the signature phrase its chip
// inserts (taken from the definition, editable here before inserting). The check looks for this phrase's words, so a
// wrong extraction is fixed once, here, for every shot. The full definition is the tag's tooltip. A character that no
// shot names says so (H3 draws a character that is listed but not in the segment). Motion: the list rises in first
// (motion.reveal), the hints fade in.
import { useId } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { Input } from "@/components/ui/controls";
import { CARD } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { ReferenceThumb } from "../../references/ReferenceThumb";
import type { SubjectDefinition } from "./layout";

function pictureOf(alias: string | null, references: readonly StudioReference[], library: readonly StudioLibraryItem[]): StudioLibraryItem | null {
  const reference = (alias != null && alias !== "") ? references.find((ref) => ref.kind === "image" && ref.alias === alias) : undefined;
  return (reference && library.find((item) => item.item_id === reference.item_id)) ?? null;
}

export function SubjectLegend({
  subjects,
  phrases,
  unnamed,
  references,
  library,
  disabled,
  onPhrase,
}: {
  subjects: readonly SubjectDefinition[];
  /** The phrase of each subject, in `subjects` order. */
  phrases: readonly string[];
  /** The numbers of the subjects that no shot names. */
  unnamed: readonly number[];
  references: readonly StudioReference[];
  library: readonly StudioLibraryItem[];
  disabled: boolean;
  onPhrase: (index: number, phrase: string) => void;
}) {
  const id = useId();
  return (
    <section ref={reveal(0)} aria-labelledby={`${id}-title`} className={cn(CARD, "grid gap-2 p-3")}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h3 id={`${id}-title`} className="text-data font-semibold text-fg">
          {t("角色特徵")}
        </h3>
        <p className="min-w-0 text-caption text-fg-tertiary">{t("角色按鈕會插入「<Subject N> ＋這段文字」，檢查也找這些詞；從定義抽出的不對，就在這裡改。")}</p>
      </div>
      <ul className="grid gap-1.5">
        {subjects.map((subject, index) => {
          const item = pictureOf(subject.image, references, library);
          const tag = `<Subject ${String(subject.number)}>`;
          const phrase = phrases[index] ?? "";
          return (
            <li key={subject.number} className="grid grid-cols-[auto_minmax(6rem,10rem)_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5">
              <ReferenceThumb item={item} kind="image" className="size-8" />
              <span className="grid min-w-0" title={subject.text}>
                <span className="machine text-data text-fg">{tag}</span>
                {item ? <span className="truncate text-caption text-fg-tertiary">{item.name}</span> : null}
              </span>
              <Input
                compact
                value={phrase}
                disabled={disabled}
                spellCheck={false}
                aria-label={t("{subject} 的特徵（英文）", { subject: tag })}
                placeholder="with long silver hair and a red ribbon"
                onChange={(event) => { onPhrase(index, event.target.value); }}
              />
              {phrase.trim() === "" ? <p className="col-start-3 text-caption text-warning animate-reveal">{t("寫一段髮色和配件，角色按鈕才會一起插入，檢查才知道要找什麼")}</p> : null}
              {unnamed.includes(subject.number) ? (
                <p className="col-start-3 text-caption text-warning animate-reveal">{t("沒有出現在任何鏡頭：在它出現的鏡頭按角色按鈕加入；這一段沒有它，就刪掉它的定義和參考圖")}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
