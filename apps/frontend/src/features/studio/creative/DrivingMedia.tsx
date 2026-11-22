// The driving media of the 表演影片 and 音訊驅動 方式, shown at the top of the shot's References tab: one row per role the
// shot's route takes (角色圖片, 表演影片, 驅動音訊) with its thumbnail and a choice from the project library. The choice is
// the shot's first reference of that kind (model/drivingMedia.ts), so uploads and the library picker below feed it too.
// Replaces the old 角色與場景 → 鏡頭綁定 media fields: the render goes through the shot's own 渲染鏡頭 and comes back as a
// take on the same shot.
import { AudioLines, ImageIcon, PersonStanding, type LucideIcon } from "lucide-react";
import { useId } from "react";
import type { StudioLibraryItem, StudioReference } from "@/api/generated/contracts";
import { Select } from "@/components/ui/controls";
import { CARD } from "@/components/ui/look";
import { reveal } from "@/components/ui/motion";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { drivingItem, withDrivingItem } from "../model/drivingMedia";
import { DRIVING_KIND, type DrivingRole } from "../model/providerTraits";
import { newLocalId } from "../references/ids";
import { ReferenceThumb } from "../references/ReferenceThumb";

const ROLE_LABEL: Readonly<Record<DrivingRole, string>> = {
  character_image: t("角色圖片"),
  performance_video: t("表演影片"),
  source_audio: t("驅動音訊"),
};

const ROLE_HINT: Readonly<Record<DrivingRole, string>> = {
  character_image: t("要被帶動的角色，一張全身或半身圖"),
  performance_video: t("角色要照著演的動作與表情"),
  source_audio: t("角色要照著說或唱的聲音"),
};

const ROLE_ICON: Readonly<Record<DrivingRole, LucideIcon>> = { character_image: ImageIcon, performance_video: PersonStanding, source_audio: AudioLines };

export interface DrivingMediaProps {
  /** The roles the shot's route takes, in display order. */
  roles: readonly DrivingRole[];
  library: readonly StudioLibraryItem[];
  references: readonly StudioReference[];
  onReferencesChange: (next: StudioReference[]) => void;
  /** Why the fields cannot be edited now; null when they can. */
  disabledReason: string | null;
}

export function DrivingMedia({ roles, library, references, onReferencesChange, disabledReason }: DrivingMediaProps) {
  const id = useId();
  return (
    <section aria-labelledby={`${id}-title`} className={cn(CARD, "grid gap-2 p-2.5 animate-reveal")}>
      <h3 id={`${id}-title`} className="text-data font-semibold text-fg">
        {t("驅動素材")}
      </h3>
      {roles.map((role, index) => {
        const kind = DRIVING_KIND[role];
        const chosen = drivingItem(references, library, role);
        const items = library.filter((item) => item.kind === kind);
        const Icon = ROLE_ICON[role];
        const fieldId = `${id}-${role}`;
        return (
          <div key={role} ref={reveal(index)} className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1">
            <ReferenceThumb item={chosen} kind={kind} className="row-span-2" />
            <label htmlFor={fieldId} className="flex min-w-0 items-center gap-1.5 text-caption text-fg-secondary">
              <Icon aria-hidden className="size-3.5 shrink-0" />
              <span className="font-medium text-fg">{ROLE_LABEL[role]}</span>
              <span className="min-w-0 truncate text-fg-tertiary">{ROLE_HINT[role]}</span>
            </label>
            <Select
              id={fieldId}
              compact
              value={chosen?.item_id ?? ""}
              disabled={disabledReason !== null}
              title={disabledReason ?? undefined}
              onChange={(event) => {
                const item = items.find((entry) => entry.item_id === event.target.value) ?? null;
                onReferencesChange(withDrivingItem(references, role, item, newLocalId("ref")));
              }}
            >
              <option value="">{items.length === 0 ? t("素材庫沒有可用的檔案：先上傳") : t("選擇素材…")}</option>
              {items.map((item) => (
                <option key={item.item_id} value={item.item_id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </div>
        );
      })}
    </section>
  );
}
