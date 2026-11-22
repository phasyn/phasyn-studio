// 8 區段場景編修：每個區段有生成文字（研究語言）、說明（只作證據解釋）、觀察依據、鎖定與「有意修改」。
// 鎖定＝自動修訂必須逐字保留；有意修改＝凍結成比較目標，標記時一併鎖定（解除鎖定時一併取消）。版面依自身寬度切換。
import { Lock, LockOpen, PenLine } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Disclosure } from "@/components/common/Disclosure";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/controls";
import { cn } from "@/lib/cn";
import type { EditorDraft, SceneIssue } from "../model/scene";
import { changedSections, setEvidence, setExplanation, setIntentional, setLocked, setNote, setSectionText } from "../model/scene";
import { LIMITS, SECTION_KEYS, SECTION_LABELS, SECTION_WEIGHTS, sectionText } from "../model/sections";
import type { PromptScene, SectionKey } from "../types";
import { t } from "@/i18n";

function Toggle({ pressed, onChange, label, title, icon, disabled }: { pressed: boolean; onChange: (next: boolean) => void; label: string; title: string; icon: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      disabled={disabled}
      onClick={() => { onChange(!pressed); }}
      className={cn(
        "pressable inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-caption [&_svg]:size-3.5 [&_svg]:shrink-0",
        "border-line-subtle text-fg-secondary hover:border-line-control hover:text-fg active:bg-sunken",
        "aria-pressed:border-brand-blue/50 aria-pressed:bg-brand-gradient-soft aria-pressed:text-fg aria-pressed:[&_svg]:text-brand-cyan",
        "focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function SectionBlock({
  sectionKey,
  draft,
  base,
  issues,
  readOnly,
  onChange,
}: {
  sectionKey: SectionKey;
  draft: EditorDraft;
  base: PromptScene;
  issues: readonly SceneIssue[];
  readOnly: boolean;
  onChange: (next: EditorDraft) => void;
}) {
  const id = useId();
  const scene = draft.scene;
  const section = scene.sections[sectionKey];
  const language = scene.prompt_language;
  const label = SECTION_LABELS[sectionKey];
  const intentional = draft.intentional.includes(sectionKey);
  const changed = changedSections(draft, base).includes(sectionKey);
  const observations = scene.observations.filter((item) => item.section === sectionKey);
  const sectionIssues = issues.filter((issue) => issue.section === sectionKey);
  const text = sectionText(section, language);
  return (
    <li className={cn("grid gap-2 border-b border-line-subtle px-4 py-3 last:border-b-0", section.locked && "bg-action/5")} aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${id}-title`} className="flex items-baseline gap-2 text-data font-semibold text-fg">
          {label}
          <code className="machine text-caption font-normal text-fg-tertiary">{sectionKey}</code>
        </h3>
        <span className="machine text-caption text-fg-tertiary" title={t("評分權重（越高，差異扣分越多）")}>
          {t("權重 {sectionKey}", { sectionKey: SECTION_WEIGHTS[sectionKey] })}
        </span>
        {changed ? <Badge tone="warning">{t("已修改")}</Badge> : null}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Toggle
            pressed={section.locked}
            onChange={(next) => { onChange(setLocked(draft, sectionKey, next)); }}
            label={section.locked ? t("已鎖定") : t("鎖定")}
            title={section.locked ? t("{label}已鎖定：自動修訂會逐字保留（解除時一併取消有意修改）", { label }) : t("鎖定{label}：自動修訂必須逐字保留", { label })}
            icon={section.locked ? <Lock aria-hidden /> : <LockOpen aria-hidden />}
            disabled={readOnly}
          />
          <Toggle
            pressed={intentional}
            onChange={(next) => { onChange(setIntentional(draft, sectionKey, next)); }}
            label={t("有意修改")}
            title={intentional ? t("{label}是有意修改：比較時以它為目標", { label }) : t("標記{label}為有意修改（一併鎖定；比較時以修改後的內容為目標）", { label })}
            icon={<PenLine aria-hidden />}
            disabled={readOnly}
          />
        </div>
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-text`} className="text-caption text-fg-secondary">
          {language === "zh-TW" ? t("{label}的繁體中文生成文字", { label }) : t("{label}的英文生成文字", { label })}
        </label>
        <Textarea
          id={`${id}-text`}
          compact
          rows={sectionKey === "subject" ? 3 : 2}
          maxLength={LIMITS.text}
          readOnly={readOnly}
          value={text}
          aria-invalid={sectionIssues.length > 0 || undefined}
          onChange={(event) => { onChange(setSectionText(draft, sectionKey, event.target.value)); }}
        />
        {language === "zh-TW" && section.text_en ? (
          <p className="text-caption text-fg-tertiary">
            <span>{t("英文對照：")}</span>
            <span lang="en">{section.text_en}</span>
          </p>
        ) : null}
      </div>
      <div className="grid gap-1">
        <label htmlFor={`${id}-explanation`} className="text-caption text-fg-secondary">
          {t("說明（只作證據解釋，不會進入 prompt）")}
        </label>
        <Textarea
          id={`${id}-explanation`}
          compact
          rows={1}
          className="min-h-9"
          maxLength={LIMITS.explanation}
          readOnly={readOnly}
          value={section.explanation_zh_tw}
          onChange={(event) => { onChange(setExplanation(draft, sectionKey, event.target.value)); }}
        />
      </div>
      <Disclosure summary={t("觀察依據 · {observation_idsCount}／{observationsCount}", { observation_idsCount: section.observation_ids.length, observationsCount: observations.length })}>
        {observations.length === 0 ? (
          <p className="text-caption text-fg-tertiary">{t("分析沒有屬於這個區段的觀察。")}</p>
        ) : (
          <ul className="grid gap-1">
            {observations.map((observation) => (
              <li key={observation.id}>
                <label aria-label={[observation.id, observation.claim_en].join(" ")} className="flex cursor-pointer items-start gap-2 rounded-sm py-0.5 text-caption text-fg-secondary has-disabled:cursor-default">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0 accent-action"
                    checked={section.observation_ids.includes(observation.id)}
                    disabled={readOnly}
                    onChange={(event) => { onChange(setEvidence(draft, sectionKey, observation.id, event.target.checked)); }}
                  />
                  <span className="grid gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <code className="machine text-fg-tertiary">{`${observation.id} · ${observation.view_id}`}</code>
                      <Badge tone={observation.certainty === "uncertain" ? "warning" : "neutral"}>{observation.certainty === "uncertain" ? t("不確定") : t("可見事實")}</Badge>
                    </span>
                    <span lang="en" className="text-fg">
                      {observation.claim_en}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}
      </Disclosure>
      {sectionIssues.length > 0 ? (
        <ul className="grid gap-0.5 text-caption text-danger">
          {sectionIssues.map((issue) => (
            <li key={issue.message}>{issue.message}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function SceneEditor({
  draft,
  base,
  issues,
  readOnly,
  onChange,
}: {
  draft: EditorDraft;
  /** 起點版本的場景（標示「已修改」）。 */
  base: PromptScene;
  issues: readonly SceneIssue[];
  readOnly: boolean;
  onChange: (next: EditorDraft) => void;
}) {
  const id = useId();
  const notes = draft.scene.uncertainty_notes;
  return (
    <div className="grid min-w-0 content-start">
      <ol className="grid" aria-label={t("8 個區段")}>
        {SECTION_KEYS.map((key) => (
          <SectionBlock key={key} sectionKey={key} draft={draft} base={base} issues={issues} readOnly={readOnly} onChange={onChange} />
        ))}
      </ol>
      <section className="grid gap-1 border-t border-line-subtle px-4 py-3" aria-labelledby={`${id}-uncertainty`}>
        <h3 id={`${id}-uncertainty`} className="text-data font-semibold text-fg">
          {t("不確定性")}
        </h3>
        {notes.length === 0 ? (
          <p className="text-caption text-fg-tertiary">{t("模型沒有列出不確定的項目；這不代表判讀完全正確。")}</p>
        ) : (
          <ul className="grid list-disc gap-0.5 pl-5 text-caption text-fg-secondary">
            {notes.map((note, index) => (
              <li key={`${String(index)}-${note}`}>{note}</li>
            ))}
          </ul>
        )}
      </section>
      <div className="grid gap-1 border-t border-line-subtle px-4 py-3">
        <label htmlFor={`${id}-note`} className="text-caption text-fg-secondary">
          {t("這個版本的修改備註（儲存時記在新版本上）")}
        </label>
        <Textarea id={`${id}-note`} compact rows={2} maxLength={LIMITS.note} readOnly={readOnly} value={draft.note} onChange={(event) => { onChange(setNote(draft, event.target.value)); }} />
      </div>
    </div>
  );
}
