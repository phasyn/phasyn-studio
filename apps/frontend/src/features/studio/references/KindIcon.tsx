import { AudioLines, Film, Image as ImageIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ReferenceKind } from "./materials";

const ICONS = { image: ImageIcon, video: Film, audio: AudioLines } as const;
const TONES = { image: "text-entity", video: "text-info", audio: "text-file" } as const;

/** 參考素材類型圖示（裝飾用；類型文字由呼叫端顯示）。 */
export function KindIcon({ kind, className }: { kind: ReferenceKind; className?: string }) {
  const Icon = ICONS[kind];
  return <Icon aria-hidden className={cn("size-4 shrink-0", TONES[kind], className)} />;
}
