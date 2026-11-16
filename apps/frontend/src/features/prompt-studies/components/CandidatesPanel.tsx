// 候選（core／detailed）：已儲存版本的正式候選（prompt.scene_compile 的結果）＋編修中的即時預覽與逐區段差異。
// 預覽與元件用同一套規則，但正式候選以儲存時的編譯結果為準；兩者不一致時照實提醒。
import { Copy, TriangleAlert } from "lucide-react";
import { useId } from "react";
import { CopyButton } from "@/components/common/values";
import { Badge } from "@/components/ui/badge";
import { Callout } from "@/components/ui/callout";
import { reveal } from "@/components/ui/motion";
import { SegmentedTabs } from "@/components/flow/SegmentedTabs";
import { diffChars } from "@/lib/textDiff";
import { cn } from "@/lib/cn";
import { candidateDiff, candidateOf, compilePreview, detailedOnlySections, diffCounts, previewAgrees, type SectionDiffRow } from "../model/compile";
import type { EditorDraft } from "../model/scene";
import { draftChanged } from "../model/scene";
import { SECTION_LABELS, VARIANT_LABELS } from "../model/sections";
import { promptTokenState, type PromptTokenState } from "../model/study";
import type { PromptStudy, PromptStudyVersion, PromptVariant } from "../types";
import { t } from "@/i18n";
import { formatList } from "@/i18n/format";

const TOKEN_TEXT: Record<PromptTokenState, { text: string; tone: "success" | "danger" | "neutral" }> = {
  accepted: { text: t("TE 已接受（生成成功過，未超過 token 上限）"), tone: "success" },
  verified: { text: t("已用目標模型檢查 token"), tone: "success" },
  too_long: { text: t("超過 token 上限（生成時 PROMPT_TOO_LONG）：先縮短或修訂"), tone: "danger" },
  unchecked: { text: t("還沒用目標模型的實際模板檢查 token；生成時超過上限會回報，不會截斷"), tone: "neutral" },
};

const STATUS_TEXT: Record<SectionDiffRow["status"], { text: string; tone: "neutral" | "info" | "success" | "danger" }> = {
  same: { text: t("相同"), tone: "neutral" },
  changed: { text: t("修改"), tone: "info" },
  // 差異狀態（Added／Removed），不是按鈕的「新增／移除」：用 context 區分譯文
  added: { text: t("新增", undefined, { context: "diff-status" }), tone: "success" },
  removed: { text: t("移除", undefined, { context: "diff-status" }), tone: "danger" },
};

function InlineDiff({ before, after }: { before: string; after: string }) {
  return (
    <p className="text-caption leading-5 [overflow-wrap:anywhere]">
      {diffChars(before, after).map((part, index) =>
        part.op === "equal" ? (
          <span key={index} className="text-fg-secondary">
            {part.text}
          </span>
        ) : part.op === "delete" ? (
          <del key={index} className="rounded-xs bg-danger/15 text-danger decoration-danger/60">
            {part.text}
          </del>
        ) : (
          <ins key={index} className="rounded-xs bg-success/15 text-success no-underline">
            {part.text}
          </ins>
        ),
      )}
    </p>
  );
}

/** 逐區段差異表（只列有變動的區段；相同的收成一行計數）。 */
export function SectionDiffList({ rows, label }: { rows: readonly SectionDiffRow[]; label: string }) {
  const counts = diffCounts(rows);
  const changed = rows.filter((row) => row.status !== "same");
  return (
    <div className="grid gap-1.5">
      <p className="text-caption text-fg-tertiary">{t("{label}：修改 {changed}、新增 {added}、移除 {removed}、相同 {same}", { label, changed: counts.changed, added: counts.added, removed: counts.removed, same: counts.same })}</p>
      {changed.length === 0 ? (
        <p className="text-caption text-fg-secondary">{t("文字沒有差異。")}</p>
      ) : (
        <ul className="grid gap-1.5">
          {changed.map((row, index) => (
            <li key={row.key} ref={reveal(index)} className={"grid gap-0.5 rounded-lg border border-line-subtle px-2.5 py-1.5"}>
              <span className="flex items-center gap-2 text-caption">
                <Badge tone={STATUS_TEXT[row.status].tone}>{STATUS_TEXT[row.status].text}</Badge>
                <span className="text-fg">{SECTION_LABELS[row.key]}</span>
                <code className="machine text-fg-tertiary">{row.key}</code>
              </span>
              {row.status === "changed" ? (
                <InlineDiff before={row.before ?? ""} after={row.after ?? ""} />
              ) : (
                <p className={cn("text-caption [overflow-wrap:anywhere]", row.status === "removed" ? "text-danger line-through" : "text-success")}>{row.after ?? row.before}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CandidatesPanel({
  study,
  version,
  previous,
  draft,
  variant,
  onVariant,
}: {
  study: PromptStudy;
  version: PromptStudyVersion;
  /** 上一版（parent，沒有時為 null）：顯示這一版改了什麼。 */
  previous: PromptStudyVersion | null;
  draft: EditorDraft | null;
  variant: PromptVariant;
  onVariant: (variant: PromptVariant) => void;
}) {
  const id = useId();
  const candidate = candidateOf(version, variant);
  const savedInput = { scene: version.scene, intentional: version.intentional_changes };
  const editing = draft !== null && draftChanged(draft);
  const preview = draft ? compilePreview({ scene: draft.scene, intentional: draft.intentional })[variant] : null;
  const token = candidate ? promptTokenState(study, candidate.prompt_sha256, candidate.token_status) : null;
  const onlyDetailed = detailedOnlySections(savedInput);
  return (
    <section className="grid min-w-0 content-start gap-3" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`${id}-title`} className="text-section font-semibold text-fg">
          {t("候選 prompt")}
        </h2>
        <SegmentedTabs
          tabs={(["core", "detailed"] as const).map((item) => ({ id: item, label: VARIANT_LABELS[item] }))}
          value={variant}
          onChange={(next) => onVariant(next === "detailed" ? "detailed" : "core")}
          idPrefix={`${id}-variant`}
          label={t("候選種類")}
        />
      </div>
      <p className="text-caption text-fg-tertiary">
        {t("core＝主體、動作、構圖、風格、可見文字，加上鎖定與有意修改的區段；detailed＝全部 8 區段。{value}", { value: onlyDetailed.length > 0 ? t(" 這一版 detailed 多了：{map}。", { map: formatList(onlyDetailed.map((key) => SECTION_LABELS[key])) }) : t(" 這一版 core 與 detailed 文字相同（只會生成一次）。") })}
      </p>
      <div role="tabpanel" id={`${id}-variant-panel-${variant}`} aria-labelledby={`${id}-variant-tab-${variant}`} className="grid gap-3">
        {candidate ? (
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-caption text-fg-secondary">{t("已儲存的候選（{variant}）· {promptCount} 字", { variant: VARIANT_LABELS[variant], promptCount: Array.from(candidate.prompt).length })}</span>
              <CopyButton value={candidate.prompt} label={t("複製 {variant} 候選", { variant })} />
            </div>
            <pre tabIndex={0} aria-label={t("已儲存的 {variant} 候選", { variant })} className="max-h-64 overflow-auto rounded-lg border border-line-subtle bg-sunken px-3 py-2 font-mono text-caption leading-5 whitespace-pre-wrap text-fg [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-focus">
              {candidate.prompt || t("（空白）")}
            </pre>
            {token ? <p className={cn("text-caption", token === "too_long" ? "text-danger" : token === "unchecked" ? "text-fg-tertiary" : "text-success")}>{TOKEN_TEXT[token].text}</p> : null}
            <p className="machine text-caption text-fg-tertiary">{t("{compiler_version} · {sectionsCount} 個區段{value}", { compiler_version: version.candidates.compiler_version, sectionsCount: candidate.sections.length, value: candidate.target_tokens !== null ? ` · ${candidate.target_tokens} tokens` : "" })}</p>
            {candidate.token_reason ? <p className="text-caption text-fg-tertiary">{candidate.token_reason}</p> : null}
          </div>
        ) : (
          <Callout tone="warning" title={t("這一版沒有 {variant} 候選", { variant })} className="rounded-lg">
            <p>{t("版本資料不完整；可以修改後重新儲存，產生新的候選。")}</p>
          </Callout>
        )}
        {!previewAgrees(version) ? (
          <Callout tone="warning" icon={<TriangleAlert />} title={t("編譯結果與本頁預覽規則不同")}>
            <p>{t("元件可能使用不同版本的編譯器；下方的草稿預覽只供參考，正式候選以儲存時元件的結果為準。")}</p>
          </Callout>
        ) : null}
        {editing && preview ? (
          <div className="grid gap-1.5 rounded-xl border border-warning/40 bg-warning/5 p-2.5 animate-rise-in">
            <p className="flex items-center gap-1.5 text-caption font-medium text-warning">
              <Copy aria-hidden className="size-3.5" />
              {t("草稿預覽（還沒儲存；儲存時由 prompt.scene_compile 編譯）")}
            </p>
            <pre className="max-h-48 overflow-auto rounded-lg bg-sunken px-3 py-2 font-mono text-caption leading-5 whitespace-pre-wrap text-fg-secondary [overflow-wrap:anywhere]">{preview.prompt || t("（空白）")}</pre>
            {preview.tooLong ? <p className="text-caption text-danger">{t("超過 12,000 字，元件會拒絕編譯。")}</p> : null}
            <SectionDiffList rows={candidateDiff(savedInput, { scene: draft.scene, intentional: draft.intentional }, variant)} label={t("與已儲存的候選相比")} />
          </div>
        ) : null}
        {previous ? (
          <SectionDiffList rows={candidateDiff({ scene: previous.scene, intentional: previous.intentional_changes }, savedInput, variant)} label={t("這一版與上一版相比")} />
        ) : null}
      </div>
    </section>
  );
}
