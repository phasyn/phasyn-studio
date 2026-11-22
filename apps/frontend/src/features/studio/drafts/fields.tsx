import { Input, Select } from "@/components/ui/controls";
import { errorText } from "@/lib/errors";
import { ApiError } from "@/api/http";
import { t } from "@/i18n";

export function Choice({
  label,
  value,
  items,
  onChange,
  optional = false,
}: {
  label: string;
  value: string;
  items: { id: string; title: string }[];
  onChange: (value: string) => void;
  optional?: boolean;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-caption text-fg-secondary">
      {label}
      <Select required={!optional} compact value={value} onChange={(e) => { onChange(e.target.value); }}>
        {(optional || !items.length) && <option value="">{optional ? t("略過") : t("沒有相容選項")}</option>}
        {items.map((item) => (
          <option key={item.id} value={item.id}>
            {item.title}
          </option>
        ))}
      </Select>
    </label>
  );
}
export function Count({
  label,
  value,
  onChange,
  min = 1,
  max,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max: number;
  placeholder?: string;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-caption text-fg-secondary">
      {label}
      <Input
        compact
        type="number"
        min={min}
        max={max}
        step="1"
        required={placeholder === undefined}
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onChange(e.target.value); }}
      />
    </label>
  );
}
export function Failure({ error }: { error: unknown }) {
  if (!(error != null)) return null;
  const reason = error instanceof ApiError ? error.details["reason"] : undefined;
  return (
    <p role="alert" className="break-words text-caption text-danger">
      {errorText(error)} {typeof reason === "string" && <code>{reason}</code>}
    </p>
  );
}
