// 參考素材的縮圖（@ 候選清單 40 px、未提供參考管理時的參考清單）：圖片本身、影片首格、聲音用圖示；角落標出類型。
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { cn } from "@/lib/cn";
import { KindIcon } from "./KindIcon";
import type { ReferenceKind } from "./materials";
import { LibraryThumb } from "./ReferenceRow";

export function ReferenceThumb({ item, kind, className }: { item: StudioLibraryItem | null; kind: ReferenceKind; className?: string }) {
  return (
    <span aria-hidden className={cn("relative grid size-10 shrink-0 place-items-center overflow-hidden rounded-md border border-line-subtle bg-stage", className)}>
      <LibraryThumb item={item ?? undefined} />
      {item && kind !== "audio" ? (
        <span className="absolute right-0.5 bottom-0.5 grid size-3.5 place-items-center rounded-sm bg-sunken/85">
          <KindIcon kind={kind} className="size-2.5" />
        </span>
      ) : null}
    </span>
  );
}
