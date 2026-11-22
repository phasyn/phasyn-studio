import { Input } from "@/components/ui/controls";
import { folderDisplayPath } from "@/components/workbench/componentFolders";
import { t } from "@/i18n";

/**
 * 資料夾輸入（原生 combobox：input＋datalist）：可選這個 Node 現有的資料夾，也可以直接輸入新的路徑（以 / 分層）。
 * 空白＝依 provider 預設分類。檢查與正規化由呼叫端（parseFolderInput）處理，這裡只保留使用者輸入。
 */
export function FolderInput({
  id,
  value,
  onChange,
  suggestions,
  defaultFolder,
  invalid = false,
  describedBy,
  disabled,
  compact = false,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: readonly string[];
  /** 空白時採用的預設分類（顯示在 placeholder）。 */
  defaultFolder: string | null;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const listId = `${id}-options`;
  return (
    <>
      <Input
        id={id}
        compact={compact}
        list={listId}
        value={value}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
        placeholder={(defaultFolder != null && defaultFolder !== "") ? t("空白＝{defaultFolder}（預設分類）", { defaultFolder: folderDisplayPath(defaultFolder) }) : t("空白＝依 provider 預設分類")}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(event) => { onChange(event.target.value); }}
      />
      <datalist id={listId}>
        {suggestions.map((folder) => (
          <option key={folder} value={folder} />
        ))}
      </datalist>
    </>
  );
}
