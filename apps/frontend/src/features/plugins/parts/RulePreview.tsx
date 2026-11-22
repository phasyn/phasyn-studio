// 規則與生成設定的可讀預覽：擋下的寫法、必要的寫法（每一項至少要出現一種）、逐鏡（[Shot N]）的同類檢查與角色覆蓋、
// 加進 prompt 的文字；生成設定的預設值與要求。插件的文字是資料，一律以純文字呈現。內建規則的正規表示式依最外層的「|」
// 拆成一個個寫法；其他包只有詞組清單。
import type { ReactNode } from "react";
import type { StudioPluginGeneration, StudioPluginRule } from "@/api/generated/contracts";
import { t } from "@/i18n";
import { cn } from "@/lib/cn";
import { ruleItemCheck, type RuleItem } from "../model/evaluate";
import { formatGenerationValue, generationDefaults, generationFieldLabel } from "../model/generation";
import { splitAlternatives } from "../model/patterns";
import { pluginText } from "../model/text";


interface ItemWords {
  words: readonly string[];
  /** 正規表示式（內建規則）或詞組清單。 */
  regex: boolean;
  /** 詞組必須是完整的詞。 */
  whole: boolean;
}

function itemWords(item: RuleItem): ItemWords {
  const check = ruleItemCheck(item);
  if (check === null) return { words: [], regex: false, whole: false };
  if (check.kind === "regex") return { words: splitAlternatives(check.source), regex: true, whole: false };
  return { words: check.terms, regex: false, whole: check.word };
}

function Heading({ children, title, aside }: { children: ReactNode; title?: string; aside?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <h5 title={title} className="text-caption font-semibold text-fg-tertiary">
        {children}
      </h5>
      {aside}
    </div>
  );
}

function Words({ item, tone }: { item: RuleItem; tone: "forbid" | "require" }) {
  const { words, regex, whole } = itemWords(item);
  const note = regex ? t("正規表示式，不分大小寫") : whole ? t("詞組清單：完整的詞才算，不分大小寫") : t("詞組清單：不分大小寫，空白與連字號視為相同");
  return (
    <li className="grid gap-1.5">
      <p className="text-data text-fg [overflow-wrap:anywhere]">{pluginText(item.message, item.id)}</p>
      <ul aria-label={note} title={note} className="flex flex-wrap gap-1">
        {words.map((text, index) => (
          <li
            key={`${String(index)}:${text}`}
            className={cn(
              "machine max-w-full rounded-md border px-1.5 py-px text-caption",
              tone === "forbid" ? "border-danger/25 bg-danger/8 text-danger" : "border-success/25 bg-success/8 text-success",
            )}
          >
            {text}
          </li>
        ))}
      </ul>
    </li>
  );
}

function ShotChecks({ shots }: { shots: NonNullable<StudioPluginRule["shots"]> }) {
  const forbid = shots.forbid ?? [];
  const require = shots.require ?? [];
  const every = shots.every_subject;
  return (
    <>
      {forbid.length > 0 ? (
        <section className="grid gap-1.5">
          <Heading title={t("任何一個 [Shot N] 鏡頭的描述出現其中任何一種寫法就不能渲染（台詞不算）")}>{t("逐鏡擋下的寫法")}</Heading>
          <ul className="grid gap-2.5">
            {forbid.map((item) => (
              <Words key={item.id} item={item} tone="forbid" />
            ))}
          </ul>
        </section>
      ) : null}
      {require.length > 0 ? (
        <section className="grid gap-1.5">
          <Heading title={t("每一個點名 <Subject N> 的鏡頭，每一項都要出現至少一種寫法，否則不能渲染")}>{t("逐鏡必要的寫法")}</Heading>
          <ul className="grid gap-2.5">
            {require.map((item) => (
              <Words key={item.id} item={item} tone="require" />
            ))}
          </ul>
        </section>
      ) : null}
      {every ? (
        <section className="grid gap-1.5">
          <Heading title={t("subject_definitions 定義的每個 <Subject N> 都要在某個 [Shot N] 鏡頭被點名，否則不能渲染")}>{t("每個角色都要出場")}</Heading>
          <p className="text-data text-fg [overflow-wrap:anywhere]">{pluginText(every.message, every.id)}</p>
        </section>
      ) : null}
    </>
  );
}

export function RulePreview({ rule, className }: { rule: StudioPluginRule; className?: string }) {
  const forbid = rule.forbid ?? [];
  const require = rule.require ?? [];
  const inject = (rule.inject ?? "").trim();
  const description = pluginText(rule.description);
  const shots = rule.shots;
  const shotChecks = shots ? (shots.forbid?.length ?? 0) + (shots.require?.length ?? 0) + (shots.every_subject ? 1 : 0) : 0;
  return (
    <div className={cn("grid min-w-0 gap-3", className)}>
      {description ? <p className="text-data leading-6 text-fg-secondary [overflow-wrap:anywhere]">{description}</p> : null}
      {forbid.length > 0 ? (
        <section className="grid gap-1.5">
          <Heading title={t("prompt 出現其中任何一種寫法就不能渲染")}>{t("擋下的寫法")}</Heading>
          <ul className="grid gap-2.5">
            {forbid.map((item) => (
              <Words key={item.id} item={item} tone="forbid" />
            ))}
          </ul>
        </section>
      ) : null}
      {require.length > 0 ? (
        <section className="grid gap-1.5">
          <Heading title={t("每一項都要在 prompt 出現至少一種寫法，否則不能渲染")}>{t("必要的寫法")}</Heading>
          <ul className="grid gap-2.5">
            {require.map((item) => (
              <Words key={item.id} item={item} tone="require" />
            ))}
          </ul>
        </section>
      ) : null}
      {shots && shotChecks > 0 ? <ShotChecks shots={shots} /> : null}
      {inject ? (
        <section className="grid gap-1.5">
          <Heading title={t("渲染前加在 detailed_description 開頭；prompt 已有同一段時不重複加")}>{t("加進 prompt 的文字")}</Heading>
          <p className="machine rounded-lg border border-line-subtle bg-sunken px-2.5 py-2 text-caption leading-5 text-fg-secondary">{inject}</p>
        </section>
      ) : null}
      {forbid.length === 0 && require.length === 0 && shotChecks === 0 && !inject ? <p className="text-data text-fg-tertiary">{t("這條規則沒有比對條件，也不加任何文字。")}</p> : null}
    </div>
  );
}

export function GenerationPreview({ generation, className }: { generation: StudioPluginGeneration; className?: string }) {
  const defaults = generationDefaults(generation);
  const require = generation.require ?? [];
  const description = pluginText(generation.description);
  return (
    <div className={cn("grid min-w-0 gap-3", className)}>
      {description ? <p className="text-data leading-6 text-fg-secondary [overflow-wrap:anywhere]">{description}</p> : null}
      {defaults.length > 0 ? (
        <section className="grid gap-1.5">
          <Heading title={t("按「套用」時才寫進專案；渲染時不會自動套用")}>{t("預設值")}</Heading>
          <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-data">
            {defaults.map((item) => (
              <div key={item.field} className="contents">
                <dt className="text-fg-tertiary">{item.label}</dt>
                <dd className="machine m-0 text-fg">{item.text}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
      {require.length > 0 ? (
        <section className="grid gap-1.5">
          <Heading title={t("專案選用這個生成設定時，不符合就不能渲染；兩邊的值都不會被改")}>{t("渲染時的要求")}</Heading>
          <ul className="grid gap-2.5">
            {require.map((item) => (
              <li key={item.id} className="grid gap-1.5">
                <p className="text-data text-fg [overflow-wrap:anywhere]">{pluginText(item.message, item.id)}</p>
                <p className="flex flex-wrap items-center gap-1 text-caption text-fg-tertiary">
                  <span>{generationFieldLabel(item.field)}</span>
                  {(item.in as readonly unknown[]).map((value) => (
                    <span key={formatGenerationValue(value)} className="machine rounded-md border border-file/30 bg-file/8 px-1.5 py-px text-file">
                      {formatGenerationValue(value)}
                    </span>
                  ))}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
