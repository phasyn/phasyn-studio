// Wizard step 2: characters (one reference image each), the swap limit note and the overall description.
import { MemoryStick, PaintBucket, Plus } from "lucide-react";
import { useId } from "react";
import type { StudioLibraryItem } from "@/api/generated/contracts";
import { ActionButton } from "@/components/common/ActionButton";
import { Input } from "@/components/ui/controls";
import { NoteList, Section } from "../fields";
import { AREA_WARNING, characterLimitReason, maxFramesFor } from "../limits";
import { FIELD_LIMITS } from "../prompt";
import type { SwapDraftApi } from "../useSwapDraft";
import type { WizardDerived } from "../wizardModel";
import { CharacterPanel } from "./CharacterPanel";
import { Label } from "./Label";
import { LimitNote } from "./LimitNote";
import { frameSeconds } from "./format";
import { t } from "@/i18n";

export function CharactersStep({ api, derived, library }: { api: SwapDraftApi; derived: WizardDerived; library: readonly StudioLibraryItem[] }) {
  const { draft, update, addCharacter } = api;
  const id = useId();
  const images = library.filter((item) => item.kind === "image");
  const limit = derived.limit.maxCharacters;
  const addReason = draft.characters.length >= limit ? characterLimitReason(derived.limit) : null;
  const areaWarning = derived.area !== null && derived.measuredArea !== null && derived.area > derived.measuredArea && draft.characters.length <= limit ? [AREA_WARNING] : [];
  // The per-segment limit can depend on the character count: say so next to the button when one more character lowers it
  const nextFrames = maxFramesFor(derived.limit, draft.characters.length + 1);
  const lowerNext =
    !addReason && nextFrames < derived.frameLimit
      ? t("新增第 {charactersCount} 個角色後，每段上限從 {frameLimit} 影格（{frameLimit2}）降到 {nextFrames} 影格（{nextFrames2}）", { charactersCount: draft.characters.length + 1, frameLimit: derived.frameLimit, frameLimit2: frameSeconds(derived.frameLimit), nextFrames, nextFrames2: frameSeconds(nextFrames) })
      : null;
  return (
    <div className="grid gap-5">
      <p className="text-caption text-fg-tertiary">
        {t("每個角色一張人設圖（白底或透明背景；透明圖會另存白底副本給模型，原圖不修改）。「取代影片中的誰」「外觀」「不應出現的特徵」建議用英文，會原樣寫進 prompt。")}
      </p>
      <LimitNote derived={derived} api={api} />
      {draft.characters.map((character, index) => (
        <CharacterPanel key={character.id} index={index} character={character} api={api} images={images} imageEdge={derived.imageEdge} />
      ))}
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton size="sm" variant="secondary" icon={<Plus aria-hidden />} disabledReason={addReason} onClick={addCharacter}>
            {t("新增角色")}
          </ActionButton>
          <span className="machine text-caption text-fg-tertiary">
            {t("{charactersCount}／{limit}", { charactersCount: draft.characters.length, limit })}
          </span>
        </div>
        {addReason || lowerNext ? <p className="text-caption text-fg-tertiary [overflow-wrap:anywhere]">{addReason ?? lowerNext}</p> : null}
      </div>
      <NoteList tone="warning" icon={<MemoryStick aria-hidden />} items={areaWarning} />
      <Section title={t("整體描述（選填，英文）")} icon={<PaintBucket />}>
        <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="grid gap-1">
            <Label htmlFor={`${id}-style`} hint={t("空白＝沿用參考影片的畫風、光線與場景")}>
              {t("畫面風格")}
            </Label>
            <Input id={`${id}-style`} compact maxLength={FIELD_LIMITS.style} value={draft.style} placeholder="2D Japanese anime film style with crisp line art and cel shading" onChange={(event) => update({ style: event.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`${id}-language`} hint={t("例如 Japanese；空白＝不指定")}>
              {t("台詞語言")}
            </Label>
            <Input id={`${id}-language`} compact maxLength={FIELD_LIMITS.language} value={draft.dialogueLanguage} placeholder="Japanese" onChange={(event) => update({ dialogueLanguage: event.target.value })} />
          </div>
        </div>
      </Section>
    </div>
  );
}
