// Icon per render queue item kind.
import { Download, Film, ListVideo, Shuffle } from "lucide-react";

export const KIND_ICON = { shot: Film, variations: Shuffle, batch: ListVideo, export: Download } as const;
