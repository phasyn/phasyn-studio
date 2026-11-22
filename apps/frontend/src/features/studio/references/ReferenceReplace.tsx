// 參考素材「換成其他檔案」：保留 @ 名稱、送出順序與 prompt 裡的寫法，只換掉它指向的檔案（同一類）。可以從專案素材庫選，
// 或上傳新檔案（上傳完成後才換，失敗時原本的檔案不變）。影片與聲音的片段在新檔案放得下時保留（像 Premiere 的取代素材），
// 放不下或長度未知時回到整個檔案；原聲設定保留。
// 外觀：與「片段與原聲」同一種展開區，以 reveal 出現；按鈕是共用的 pressable。
import { Upload } from "lucide-react";
import { useId, useRef } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { itemFacts } from "./display";
import { KIND_LABEL } from "./materials";
import { t } from "@/i18n";

export interface ReplaceChoices {
  /** 同一類、可以換成的素材庫檔案（不含目前的）。 */
  items: readonly StudioLibraryItem[];
  onReplace: (itemId: string) => void;
  /** 上傳新檔案並在完成後換掉（不提供＝只能從素材庫選）。 */
  onUpload?: (file: File) => void;
}

export function ReferenceReplace({ reference, choices, disabled, onDone }: { reference: StudioReference; choices: ReplaceChoices; disabled: boolean; onDone: () => void }) {
  const id = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const kind = KIND_LABEL[reference.kind];
  return (
    <div className="grid gap-1.5 rounded-md border border-line-subtle bg-sunken/60 p-2 text-caption animate-reveal">
      <label htmlFor={`${id}-pick`} className="text-fg-secondary">
        {t("把 @{alias} 換成另一個{kind}（@ 名稱與 prompt 不變）", { alias: reference.alias, kind })}
      </label>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select
          id={`${id}-pick`}
          compact
          value=""
          disabled={disabled || choices.items.length === 0}
          onChange={(event) => {
            if (!event.target.value) return;
            choices.onReplace(event.target.value);
            onDone();
          }}
          className="min-w-0 flex-1"
        >
          <option value="">{choices.items.length === 0 ? t("素材庫沒有其他{kind}", { kind }) : t("從素材庫選…")}</option>
          {choices.items.map((item) => (
            <option key={item.item_id} value={item.item_id}>
              {t("{name}（{facts}）", { name: item.name, facts: itemFacts(item) || kind })}
            </option>
          ))}
        </Select>
        {choices.onUpload ? (
          <>
            <Button size="sm" variant="secondary" icon={<Upload aria-hidden />} disabled={disabled} onClick={() => fileInputRef.current?.click()}>
              {t("上傳新檔案")}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept={`${reference.kind}/*`}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (!file || !choices.onUpload) return;
                choices.onUpload(file);
                onDone();
              }}
            />
          </>
        ) : null}
      </div>
      {reference.kind !== "image" ? <p className="text-fg-tertiary">{t("新檔案放得下目前的片段時保留起點與終點，放不下就回到整個檔案；需要的話再到「片段與原聲」調整。")}</p> : null}
    </div>
  );
}
