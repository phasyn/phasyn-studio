import { t } from "@/i18n";

/** Imported media can supply a playable take without a generator seed. */
export function takeLabel(number: number, seed: number | null): string {
  return seed === null ? t("take {number}", { number }) : t("take {take}・seed {seed}", { take: number, seed });
}
