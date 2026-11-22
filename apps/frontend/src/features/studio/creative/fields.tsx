import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/controls";
import { t } from "@/i18n";

import { errorText } from "@/lib/errors";
import type { FieldRow } from "./fieldValues";

export function FieldRows({ label, rows, onChange }: { label: string; rows: FieldRow[]; onChange: (rows: FieldRow[]) => void }) {
  function update(id: string, patch: Partial<FieldRow>) {
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-caption font-medium text-fg-secondary">{label}</legend>
      {rows.map((r) => (
        <div key={r.id} className="grid grid-cols-[minmax(5.5rem,0.42fr)_minmax(8rem,1fr)_auto] items-start gap-2">
          <Input
            compact
            aria-label={t("欄位代號")}
            placeholder="costume"
            value={r.key}
            maxLength={160}
            onChange={(e) => { update(r.id, { key: e.target.value }); }}
          />
          <Textarea
            compact
            rows={1}
            className="min-h-8"
            aria-label={t("欄位內容")}
            maxLength={2000}
            value={r.value}
            onChange={(e) => { update(r.id, { value: e.target.value }); }}
          />
          <Button
            size="sm"
            variant="quiet"
            aria-label={t("移除欄位")}
            onClick={() => { onChange(rows.filter((field) => field.id !== r.id)); }}
          >
            <X aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="secondary"
        className="justify-self-start"
        icon={<Plus aria-hidden />}
        disabled={rows.length >= 32}
        onClick={() => { onChange([...rows, { id: crypto.randomUUID(), key: "", value: "" }]); }}
      >
        {t("加入欄位")}
      </Button>
    </fieldset>
  );
}
export function Status({ message, error }: { message?: string | undefined; error?: unknown }) {
  if ((error != null))
    return (
      <p role="alert" className="rounded-md border border-danger/40 bg-raised p-2 text-caption text-danger">
        {errorText(error)}
      </p>
    );
  return (message != null && message !== "") ? (
    <p role="status" className="text-caption text-fg-secondary">
      {message}
    </p>
  ) : null;
}
