import { isListed } from "@/lib/json";
// 專業編輯器中間：選取區塊的標題欄位（依類型）與內容編輯。內容編輯是「改原文中這一段」：開始輸入時記下
// 前後文，之後每次輸入都是 前文＋內容＋後文，即使輸入的文字讓區塊重新切分也不會跳字或重複。
import { ArrowDown, ArrowUp, Copy, Trash2 } from "lucide-react";
import { useId, useRef, useState, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Select } from "@/components/ui/controls";
import { bodyContext, formatSeconds, H3_SECTIONS, parseSecondsInput, serializePrompt, setBlockHeading, type HeadingEdit, type PromptBlock, type PromptDocument } from "./blocks";
import { BlockKindIcon } from "./BlockOutline";
import { PROMPT_MAX_LENGTH } from "./compile";
import { DraftField } from "./DraftField";
import type { MentionOption } from "./mentions";
import { MentionTextarea, type MentionTextareaHandle } from "./MentionTextarea";
import { describeBlock, KIND_LABELS, SECTION_HINTS } from "./outline";
import { t } from "@/i18n";
import { T } from "@/i18n/T";

function BlockBodyEditor({
  doc,
  index,
  value,
  onChange,
  options,
  editorRef,
  disabled,
  labelId,
}: {
  doc: PromptDocument;
  index: number;
  value: string;
  onChange: (next: string) => void;
  options: readonly MentionOption[];
  editorRef: Ref<MentionTextareaHandle>;
  disabled: boolean;
  labelId: string;
}) {
  const [session, setSession] = useState<{ prefix: string; suffix: string; draft: string } | null>(null);
  const context = bodyContext(doc, index);
  const live = session !== null && value === session.prefix + session.draft + session.suffix ? session : null;
  const base = live ?? (context ? { prefix: context.prefix, suffix: context.suffix, draft: context.body } : null);
  if (!base) return null;
  return (
    <MentionTextarea
      ref={editorRef}
      value={base.draft}
      options={options}
      disabled={disabled}
      describedBy={labelId}
      ariaLabel={t("區塊內容")}
      maxLength={Math.max(0, PROMPT_MAX_LENGTH - base.prefix.length - base.suffix.length)}
      placeholder={t("輸入這個區塊的內容；輸入 @ 插入參考素材")}
      onChange={(draft) => {
        setSession({ prefix: base.prefix, suffix: base.suffix, draft });
        onChange(base.prefix + draft + base.suffix);
      }}
      onBlur={() => { setSession(null); }}
      containerClassName="flex min-h-0 flex-1 flex-col"
      className="min-h-64 flex-1 resize-none text-data leading-7"
    />
  );
}

function HeadingFields({ block, onEdit, disabled }: { block: PromptBlock; onEdit: (edit: HeadingEdit) => string | null; disabled: boolean }) {
  const id = useId();
  const seconds = (field: "start" | "end") => (text: string) => {
    const parsed = parseSecondsInput(text);
    if (parsed.error != null && parsed.error !== "") return parsed.error;
    if (parsed.value === null) return t("請輸入秒數");
    const range = block.range ?? { start: 0, end: 2 };
    return onEdit({ type: "range", range: { ...range, [field]: parsed.value } });
  };
  const decimals = block.style?.type === "time" ? block.style.decimals : 3;
  const rangeFields = (
    <>
      <label htmlFor={`${id}-start`} className="text-caption text-fg-tertiary">
        {t("起點（秒）")}
      </label>
      <DraftField id={`${id}-start`} label={t("起點（秒）")} mono inputMode="decimal" disabled={disabled} value={block.range ? formatSeconds(block.range.start, decimals) : ""} onCommit={seconds("start")} className="w-24" />
      <label htmlFor={`${id}-end`} className="text-caption text-fg-tertiary">
        {t("終點（秒）")}
      </label>
      <DraftField id={`${id}-end`} label={t("終點（秒）")} mono inputMode="decimal" disabled={disabled} value={block.range ? formatSeconds(block.range.end, decimals) : ""} onCommit={seconds("end")} className="w-24" />
    </>
  );
  if (block.kind === "section") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-section`} className="text-caption text-fg-tertiary">
          {t("區段")}
        </label>
        <Select id={`${id}-section`} compact className="machine min-h-7" value={block.section ?? ""} disabled={disabled} onChange={(event) => { const value = event.target.value; if (isListed(value, H3_SECTIONS)) void onEdit({ type: "section", section: value }); }}>
          {H3_SECTIONS.map((section) => (
            <option key={section} value={section}>
              {section}
            </option>
          ))}
        </Select>
      </div>
    );
  }
  if (block.kind === "shot") {
    const cut = block.style?.type === "shot" && block.style.form === "cut";
    const commitCue = (text: string) => {
      const parsed = parseSecondsInput(text);
      if (parsed.error != null && parsed.error !== "") return parsed.error;
      return onEdit({ type: "cue", cue: parsed.value });
    };
    return (
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-shot`} className="text-caption text-fg-tertiary">
          {t("鏡頭")}
        </label>
        <DraftField
          id={`${id}-shot`}
          label={t("鏡頭編號")}
          mono
          inputMode="numeric"
          disabled={disabled}
          value={String(block.shot ?? 1)}
          className="w-16"
          onCommit={(text) => (/^\d+$/.test(text.trim()) ? onEdit({ type: "shot", shot: Number(text.trim()) }) : t("鏡頭編號必須是 1–999 的整數"))}
        />
        {cut ? (
          <>
            <label htmlFor={`${id}-cue`} className="text-caption text-fg-tertiary">
              {t("切入時間（秒）")}
            </label>
            <DraftField
              id={`${id}-cue`}
              label={t("切入時間（秒）")}
              mono
              inputMode="decimal"
              disabled={disabled}
              value={block.cue !== null ? formatSeconds(block.cue, 3) : ""}
              placeholder={block.shot === 1 ? t("第一鏡不加") : t("未標")}
              onCommit={commitCue}
              className="w-24"
            />
            <span className="text-caption text-fg-tertiary">
              {block.shot === 1 && block.cue === null ? t("官方：第一鏡不加時間") : t("官方：[Shot n] At mm:ss.sss,；切鏡時間遞增且小於片長")}
            </span>
          </>
        ) : (
          rangeFields
        )}
      </div>
    );
  }
  if (block.kind === "time") return <div className="flex flex-wrap items-center gap-2">{rangeFields}</div>;
  if (block.kind === "heading") {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label htmlFor={`${id}-title`} className="text-caption text-fg-tertiary">
          {t("標題")}
        </label>
        <DraftField id={`${id}-title`} label={t("標題")} disabled={disabled} value={block.title} className="min-w-48 flex-1" onCommit={(text) => onEdit({ type: "title", title: text })} />
      </div>
    );
  }
  return <p className="text-caption text-fg-tertiary">{t("段落沒有標題；需要標題時可在全文加上「**標題：**」或用左側的「標題區塊」範本。")}</p>;
}

export function BlockEditorPane({
  doc,
  index,
  value,
  onChange,
  options,
  editorRef,
  disabled,
  onMove,
  onDuplicate,
  onDelete,
}: {
  doc: PromptDocument;
  index: number;
  value: string;
  onChange: (next: string) => void;
  options: readonly MentionOption[];
  editorRef: Ref<MentionTextareaHandle>;
  disabled: boolean;
  onMove: (delta: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const id = useId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const block = doc.blocks[index];
  if (!block) return null;
  const info = describeBlock(block);
  const edit = (change: HeadingEdit): string | null => {
    const result = setBlockHeading(doc, index, change);
    if ("error" in result) return result.error;
    // 標題欄位直接寫回原文（只換標題，不動內容）
    const text = serializePrompt(result);
    if (text.length > PROMPT_MAX_LENGTH) return t("超過 {promptMaxLength} 字元上限", { promptMaxLength: PROMPT_MAX_LENGTH });
    onChange(text);
    return null;
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid min-w-0 gap-1">
          <p id={`${id}-label`} className="flex min-w-0 items-center gap-2 text-data text-fg">
            <BlockKindIcon kind={block.kind} />
            <span className="text-caption text-fg-tertiary">
              {t("{kind} · 第 {index} / {blocksCount} 個區塊", { kind: KIND_LABELS[block.kind], index: index + 1, blocksCount: doc.blocks.length })}
            </span>
          </p>
          {block.section ? <p className="max-w-[72ch] text-caption leading-5 text-fg-tertiary">{SECTION_HINTS[block.section]}</p> : null}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("區塊操作")}>
          <Button size="icon-sm" variant="quiet" aria-label={t("上移區塊")} title={t("上移")} disabled={disabled || index === 0} onClick={() => { onMove(-1); }} icon={<ArrowUp aria-hidden />} />
          <Button size="icon-sm" variant="quiet" aria-label={t("下移區塊")} title={t("下移")} disabled={disabled || index === doc.blocks.length - 1} onClick={() => { onMove(1); }} icon={<ArrowDown aria-hidden />} />
          <Button size="sm" variant="quiet" className="min-h-8 px-2" icon={<Copy aria-hidden />} disabled={disabled} onClick={onDuplicate}>
            {t("複製", undefined, { context: "duplicate" })}
          </Button>
          <Button ref={deleteButtonRef} size="sm" variant="danger" className="min-h-8 px-2" icon={<Trash2 aria-hidden />} disabled={disabled} onClick={() => { setConfirmDelete(true); }}>
            {t("刪除")}
          </Button>
        </div>
      </div>
      {confirmDelete ? (
        <Callout tone="danger" title={t("刪除區塊「{value}」？", { value: info.title || info.kind })}>
          <p>
            <T source={"會從 prompt 移除這個區塊的標題與內容（<0>{markerCount}</0> 字元）；刪除後可以按「復原」。"} values={{ markerCount: (block.marker + block.joiner + block.body).length }} slots={[<span key="slot-0" className="machine" />]} />
          </p>
          <div className="flex gap-1.5 pt-1">
            <Button
              size="sm"
              variant="danger-confirm"
              onClick={() => {
                setConfirmDelete(false);
                onDelete();
              }}
            >
              {t("刪除區塊")}
            </Button>
            {/* 確認框連同按鈕一起消失：焦點回到「刪除」，不掉到頁面 */}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setConfirmDelete(false);
                deleteButtonRef.current?.focus();
              }}
            >
              {t("取消")}
            </Button>
          </div>
        </Callout>
      ) : null}
      <HeadingFields key={`${String(index)}:${block.marker}`} block={block} onEdit={edit} disabled={disabled} />
      <BlockBodyEditor key={index} doc={doc} index={index} value={value} onChange={onChange} options={options} editorRef={editorRef} disabled={disabled} labelId={`${id}-label`} />
    </div>
  );
}
