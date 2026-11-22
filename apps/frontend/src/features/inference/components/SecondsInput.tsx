import { useState } from "react";
import { Input } from "@/components/ui/controls";
import { parseSeconds } from "../model/materials";
import { t } from "@/i18n";

/**
 * 秒數欄位：打字時保留原文（「1.」之類的中間狀態不被改寫），每次輸入都提交解析結果；
 * 空白＝不指定（null），非數字以 NaN 提交，由素材檢查顯示錯誤（不默默改值）。
 */
export function SecondsInput({
  id,
  value,
  onChange,
  placeholder,
  disabledReason,
  label,
}: {
  id: string;
  value: number | null;
  onChange: (next: number | null) => void;
  placeholder: string;
  /** 不適用的原因（例如圖片沒有時間範圍）；有值時停用並以 title 說明。 */
  disabledReason?: string | null;
  label: string;
}) {
  const [draft, setDraft] = useState<{ base: number | null; text: string } | null>(null);
  const active = draft !== null && Object.is(draft.base, value) ? draft : null;
  const text = active ? active.text : value === null ? "" : String(value);
  const invalid = value !== null && !Number.isFinite(value);
  return (
    <Input
      id={id}
      compact
      inputMode="decimal"
      aria-label={label}
      value={(disabledReason != null && disabledReason !== "") ? "" : text}
      placeholder={(disabledReason != null && disabledReason !== "") ? t("不適用") : placeholder}
      disabled={Boolean(disabledReason)}
      title={disabledReason ?? undefined}
      aria-invalid={invalid || undefined}
      className="machine w-24"
      onChange={(event) => {
        const next = parseSeconds(event.target.value);
        setDraft({ base: next, text: event.target.value });
        onChange(next);
      }}
    />
  );
}
