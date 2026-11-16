// Shared helper of the monitor views: the playable URL of a take.
import type { StudioTake } from "@/api/generated/contracts";
import { mediaUrl } from "@/api/http";

export function takeUrl(take: StudioTake | null | undefined): string | null {
  const file = take?.state === "succeeded" ? take.asset?.file : undefined;
  return file ? mediaUrl(file.node_id, file.file_id) : null;
}
