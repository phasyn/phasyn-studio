// Why a 專案可攜包 could not be made, in the project's own words. The Controller refuses a package with missing media
// (STATE_CONFLICT, details.missing: [{ sha256, reason }]) instead of handing out an incomplete archive; the digests are
// matched here against the project's library items and shot takes, so the person reads 「miss.png」 or 「鏡頭二 take 2」
// instead of a hash. Files the project does not name (latents, conditioning, other intermediate files) are counted.
import type { StudioProject } from "@/api/generated/contracts";
import { isApiError } from "@/api/http";
import { t } from "@/i18n";
import { isRecord } from "@/lib/json";
import { takeNumber } from "./takeDownload";

export interface PortableMissing {
  /** Library items and takes the package needs, by name (each once, project order). */
  names: string[];
  /** Missing files the project does not name (intermediate generation files). */
  others: number;
}

/** The missing digests of a refused portable download; null when the error is something else. */
export function missingDigests(error: unknown): string[] | null {
  if (!isApiError(error) || error.code !== "STATE_CONFLICT") return null;
  const missing = error.details["missing"];
  if (!Array.isArray(missing)) return null;
  const digests = missing.flatMap((item) => (isRecord(item) && typeof item["sha256"] === "string" ? [item["sha256"]] : []));
  return digests.length > 0 ? digests : null;
}

export function portableMissing(project: StudioProject, digests: readonly string[], takeName: (shot: string, take: number) => string): PortableMissing {
  const named = new Map<string, string>();
  for (const item of project.library ?? []) {
    const sha = item.file.sha256;
    if (!named.has(sha)) named.set(sha, item.name);
  }
  for (const shot of project.shots) {
    for (const take of shot.takes) {
      const sha = take.asset?.file.sha256;
      if (sha !== undefined && !named.has(sha)) named.set(sha, takeName(shot.title, takeNumber(shot, take)));
    }
  }
  const wanted = new Set(digests);
  const names = [...new Set([...named].filter(([sha]) => wanted.has(sha)).map(([, name]) => name))];
  const others = [...wanted].filter((sha) => !named.has(sha)).length;
  return { names, others };
}

/**
 * The title of a project imported from a package: 「原名（匯入）」, or 「原名（匯入 2）」, 「（匯入 3）」… when that is taken, so
 * the copy is never mistaken for the project it came from.
 */
export function importTitle(title: string, taken: readonly string[]): string {
  // A title has at most 200 characters (the suffix included)
  const base = (title.trim() || t("未命名專案")).slice(0, 180);
  const used = new Set(taken);
  const first = t("{title}（匯入）", { title: base });
  if (!used.has(first)) return first;
  for (let index = 2; ; index += 1) {
    const next = t("{title}（匯入 {index}）", { title: base, index });
    if (!used.has(next)) return next;
  }
}
