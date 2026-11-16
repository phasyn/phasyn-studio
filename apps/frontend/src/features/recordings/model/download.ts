// Local downloads from the recordings pages: file names, and the redaction a shared export should carry (saving itself
// is @/lib/download; the server applies the redaction to the downloaded copy only).
import type { ExportRedaction } from "@/api/http";
import { t } from "@/i18n";

export function safeFilePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "recording";
}

/** What GET …/export can redact, in display order. */
export const REDACT_FIELDS = ["hostname", "device_ids", "prompts", "paths"] as const satisfies readonly ExportRedaction[];
export type RedactField = (typeof REDACT_FIELDS)[number];

export const REDACT_LABELS: Readonly<Record<RedactField, string>> = {
  hostname: t("主機名稱"),
  device_ids: t("裝置 ID"),
  prompts: t("prompt 文字"),
  paths: t("檔案路徑（只留檔名）"),
};

/** The `redact` values to send, in a stable order; nothing chosen → no redaction (the default). */
export function redactQuery(chosen: ReadonlySet<RedactField>): RedactField[] {
  return REDACT_FIELDS.filter((field) => chosen.has(field));
}
