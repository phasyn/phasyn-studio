import { ArrowDown, ArrowUp, ChevronRight, CircleAlert, Layers, Plus, Trash, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { InstanceSettings, Part, PartOverride } from "@/api/generated/contracts";
import { Disclosure } from "@/components/common/Disclosure";
import { EmptyState } from "@/components/common/EmptyState";
import { JsonEditor } from "@/components/common/JsonEditor";
import { SchemaForm } from "@/components/common/SchemaForm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { Table, TableScroll, Td, Th } from "@/components/ui/table";
import { cn } from "@/lib/cn";
import { hasGlob } from "@/lib/fnmatch";
import { isRecord, previewValue } from "@/lib/json";
import type { SchemaIssue } from "@/lib/schema";
import { moveItem, useStableKeys } from "@/lib/useStableKeys";
import { analyzeRules, buildPartTree, countLeaves, expandParts, type PartNode, type RuleAnalysis } from "./partsModel";
import { tServer, t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

const COVERAGE: Record<Part["coverage"], { label: string; tone: "neutral" | "warning" | "danger" }> = {
  full: { label: t("觀測完整"), tone: "neutral" },
  partial: { label: t("部分觀測"), tone: "warning" },
  none: { label: t("無觀測"), tone: "danger" },
};

function PartTreeNode({ node, depth, onAddRule, disabled }: { node: PartNode; depth: number; onAddRule: (selector: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = node.children.length > 0;
  const leaves = countLeaves(node);
  const ruleSelector = node.part && !hasChildren ? node.path : `${node.path}.*`;
  return (
    <li className="min-w-0" style={{ paddingLeft: depth > 0 ? 14 : 0 }}>
      <div className="flex min-h-9 flex-wrap items-center gap-2">
        {hasChildren ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? t("收合") : t("展開")} ${node.path}`}
            onClick={() => { setOpen((value) => !value); }}
            className="pressable inline-flex size-8 items-center justify-center rounded-md text-fg-tertiary transition-colors duration-(--duration-fast) hover:bg-raised hover:text-fg active:bg-sunken"
          >
            <ChevronRight aria-hidden className={cn("size-4 transition-[rotate] duration-(--duration-spring-snappy) ease-spring-snappy", open && "rotate-90")} />
          </button>
        ) : (
          <span aria-hidden className="inline-block w-8" />
        )}
        <code className="machine text-data text-fg">{node.segment}</code>
        {node.part ? (
          <>
            <Badge tone="entity">{node.part.kind}</Badge>
            <Badge tone={COVERAGE[node.part.coverage].tone}>{COVERAGE[node.part.coverage].label}</Badge>
          </>
        ) : null}
        {hasChildren ? <span className="text-caption text-fg-tertiary">{t("{leaves} 個 part", { leaves })}</span> : null}
        {!disabled ? (
          <Button
            size="sm"
            variant="quiet"
            icon={<Plus aria-hidden />}
            className="ml-auto"
            onClick={() => { onAddRule(ruleSelector); }}
            aria-label={t("以 {ruleSelector} 新增覆寫規則", { ruleSelector })}
          >
            {t("規則")}
          </Button>
        ) : null}
      </div>
      {node.part ? (
        <div className="grid gap-0.5 pb-1 pl-10 text-caption text-fg-tertiary">
          <span className="machine">{node.path}</span>
          {(node.part.reason != null && node.part.reason !== "") ? <span className="text-warning">{tServer(node.part.reason)}</span> : null}
          {node.part.observable.length > 0 ? <span>{t("可觀測：{observable}", { observable: formatList(node.part.observable) })}</span> : null}
        </div>
      ) : null}
      {hasChildren && open ? (
        <ul className="grid border-l border-line-subtle">
          {node.children.map((child) => (
            <PartTreeNode key={child.path} node={child} depth={depth + 1} onAddRule={onAddRule} disabled={disabled} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function RuleMatchSummary({ analysis }: { analysis: RuleAnalysis }) {
  if (analysis.selectorError != null && analysis.selectorError !== "") {
    return (
      <p className="flex items-center gap-1.5 text-caption text-danger">
        <CircleAlert aria-hidden className="size-3.5" />
        {analysis.selectorError}
      </p>
    );
  }
  if (analysis.matched.length === 0) {
    return (
      <p className="flex items-center gap-1.5 text-caption text-danger" role="alert">
        <CircleAlert aria-hidden className="size-3.5" />
        {t("沒有命中任何子部件：Node 會以 422 拒絕，儲存已停用。")}
      </p>
    );
  }
  return (
    <Disclosure summary={<span className="text-success">{t("命中 {matchedCount} 個 part（{value}）", { matchedCount: analysis.matched.length, value: hasGlob(analysis.selector) ? "fnmatch" : "exact" })}</span>}>
      <ul className="grid max-h-48 gap-0.5 overflow-y-auto rounded-md border border-line-subtle bg-sunken px-3 py-2">
        {analysis.matched.map((path) => (
          <li key={path} className="machine text-caption text-fg-secondary">
            {path}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

function RuleCard({
  rule,
  index,
  count,
  analysis,
  issues,
  disabled,
  onChange,
  onMove,
  onRemove,
}: {
  rule: PartOverride;
  index: number;
  count: number;
  analysis: RuleAnalysis;
  issues: readonly SchemaIssue[];
  disabled: boolean;
  onChange: (next: PartOverride) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  const selectorId = `part-rule-${String(index)}-selector`;
  const settings = isRecord(rule.settings) ? rule.settings : {};
  const basePath = `load.part_overrides[${String(index)}].settings`;
  const fieldSchema = { type: "object", properties: analysis.fieldSchemas, additionalProperties: false };
  const blocking = analysis.selectorError !== null || analysis.matched.length === 0 || analysis.rejected.length > 0;
  return (
    <li
      className={cn(
        "grid min-w-0 gap-3 rounded-lg border bg-sunken/40 p-3 transition-colors duration-(--duration-fast) animate-rise-in",
        blocking ? "border-danger/45" : "border-line focus-within:border-brand-blue/50",
      )}
    >
      <div className="flex flex-wrap items-end gap-2">
        <span className="machine pb-2.5 text-caption text-fg-tertiary">#{index}</span>
        <div className="grid min-w-48 flex-1 gap-1">
          <label htmlFor={selectorId} className="text-caption text-fg-secondary">
            {t("selector（exact 或 fnmatch：* ? [seq]）")}
          </label>
          <Input
            id={selectorId}
            className="machine"
            value={rule.selector}
            disabled={disabled}
            placeholder="transformer.blocks.*.attention"
            aria-invalid={analysis.selectorError !== null || analysis.matched.length === 0 || undefined}
            onChange={(event) => { onChange({ ...rule, selector: event.target.value }); }}
          />
        </div>
        <span className="flex items-center gap-1">
          <Button size="icon-sm" variant="quiet" aria-label={t("規則 #{index} 上移", { index })} disabled={disabled || index === 0} onClick={() => { onMove(index - 1); }}>
            <ArrowUp aria-hidden />
          </Button>
          <Button
            size="icon-sm"
            variant="quiet"
            aria-label={t("規則 #{index} 下移", { index })}
            disabled={disabled || index === count - 1}
            onClick={() => { onMove(index + 1); }}
          >
            <ArrowDown aria-hidden />
          </Button>
          <Button size="icon-sm" variant="danger" aria-label={t("刪除規則 #{index}", { index })} disabled={disabled} onClick={onRemove}>
            <Trash aria-hidden />
          </Button>
        </span>
      </div>
      <RuleMatchSummary analysis={analysis} />
      {analysis.overlaps.map((overlap) => (
        <p key={overlap.earlier} className="flex items-start gap-1.5 text-caption text-warning">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {overlap.fields.length > 0
            ? t("與規則 #{earlier} 重疊 {pathsCount} 個 part（欄位 {fields}）：後者覆蓋前者", { earlier: overlap.earlier, pathsCount: overlap.paths.length, fields: formatList(overlap.fields) })
            : t("與規則 #{earlier} 命中相同的 {pathsCount} 個 part，但設定不同欄位（後者覆蓋前者的規則仍適用）", { earlier: overlap.earlier, pathsCount: overlap.paths.length })}
        </p>
      ))}
      {analysis.matched.length > 0 && analysis.accepted.length > 0 ? (
        <SchemaForm
          schema={fieldSchema}
          value={settings}
          onChange={(next) => { onChange({ ...rule, settings: next }); }}
          idPrefix={`part-rule-${String(index)}`}
          basePath={basePath}
          issues={issues}
          disabled={disabled}
          allowUnset
        />
      ) : analysis.matched.length > 0 ? (
        <p className="text-caption text-fg-tertiary">{t("命中的 part 沒有共同可覆寫的欄位（各 part 的 settings_schema 交集為空）。")}</p>
      ) : (
        <JsonEditor
          id={`part-rule-${String(index)}-settings`}
          label={t("settings（命中 part 之前無法得知可用欄位）")}
          value={settings}
          onChange={(next) => { if (isRecord(next)) onChange({ ...rule, settings: next }); }}
          accept={(next) => (isRecord(next) ? null : t("settings 必須是 object"))}
          rows={3}
          disabled={disabled}
        />
      )}
      {analysis.rejected.length > 0 ? (
        <ul className="grid gap-1 text-caption text-danger" role="alert">
          {analysis.rejected.map((item) => (
            <li key={item.field}>
              <T source={"欄位 <0>{field}</0> 不被 {partsCount} 個命中的 part 接受（例如 {parts}）：Node 會以 422 拒絕。"} values={{ field: item.field, partsCount: item.parts.length, parts: item.parts[0] }} slots={[<code key="slot-0" className="machine" />]} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** 子部件頁籤：parts 樹、依序覆寫規則（exact／fnmatch）、命中與重疊提示、展開預覽。 */
export function PartsTab({
  parts,
  draft,
  onChange,
  issues,
  disabled = false,
}: {
  parts: readonly Part[];
  draft: InstanceSettings;
  onChange: (next: InstanceSettings) => void;
  issues: readonly SchemaIssue[];
  disabled?: boolean;
}) {
  const rules = draft.load.part_overrides ?? [];
  const analyses = analyzeRules(parts, rules);
  const stable = useStableKeys(rules.length);
  const tree = buildPartTree(parts);
  const setRules = (next: PartOverride[]) => { onChange({ ...draft, load: { ...draft.load, part_overrides: next } }); };
  const addRule = (selector: string) => {
    stable.append();
    setRules([...rules, { selector, settings: {} }]);
  };
  const expanded = expandParts(parts, draft.load.precision, rules).filter((item) => Object.keys(item.settings).length > 0);
  const blocking = analyses.some((analysis) => analysis.selectorError !== null || analysis.matched.length === 0 || analysis.rejected.length > 0);

  if (parts.length === 0) {
    return (
      <EmptyState
        icon={<Layers />}
        title={t("provider 沒有宣告子部件")}
        size="compact"
        description={
          <T source={"此元件的 describe 沒有提供 parts；無法設定 part_overrides。{value}"} values={{ value: rules.length > 0 ? t("草稿中仍有 {rulesCount} 條規則，Node 會以 422 拒絕。", { rulesCount: rules.length }) : null }} />
        }
      />
    );
  }

  return (
    <div className="grid min-w-0 gap-5">
      <section className="grid gap-3" aria-labelledby="part-rules-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="part-rules-title" className="text-data font-semibold text-fg">
            {t("覆寫規則 load.part_overrides（{rulesCount}）", { rulesCount: rules.length })}
          </h3>
          <Button size="sm" icon={<Plus aria-hidden />} disabled={disabled} onClick={() => { addRule(""); }}>
            {t("新增規則")}
          </Button>
        </div>
        <p className="text-caption text-fg-tertiary">
          {t("先套用共用精度，再依陣列順序覆寫（同一欄位後者優先）；selector 為 exact 或 fnmatch，「*」會跨越「.」。")}
        </p>
        {rules.length === 0 ? <p className="text-data text-fg-tertiary">{t("尚無規則；可從下方子部件樹直接新增。")}</p> : null}
        <ol className="grid gap-3">
          {rules.map((rule, index) => {
            const analysis = analyses[index];
            if (!analysis) return null;
            return (
              <RuleCard
                key={stable.keys[index]}
                rule={rule}
                index={index}
                count={rules.length}
                analysis={analysis}
                issues={issues}
                disabled={disabled}
                onChange={(next) => { setRules(rules.map((item, position) => (position === index ? next : item))); }}
                onMove={(to) => {
                  stable.move(index, to);
                  setRules(moveItem(rules, index, to));
                }}
                onRemove={() => {
                  stable.remove(index);
                  setRules(rules.filter((_, position) => position !== index));
                }}
              />
            );
          })}
        </ol>
      </section>

      <section className="grid gap-2" aria-labelledby="part-expand-title">
        <h3 id="part-expand-title" className="text-data font-semibold text-fg">
          {t("展開預覽（{expandedCount} 個 part 有設定）", { expandedCount: expanded.length })}
        </h3>
        {blocking ? (
          <p className="text-caption text-warning">{t("規則有錯誤：修正後才能得到可保存的展開結果。")}</p>
        ) : expanded.length === 0 ? (
          <p className="text-caption text-fg-tertiary">{t("目前沒有 part 會收到設定值。")}</p>
        ) : (
          <Disclosure summary={t("查看每個 part 的展開設定（保存時 Node 會展開並記錄）")}>
            <TableScroll label={t("子部件展開結果")}>
              <Table>
                <thead>
                  <tr>
                    <Th scope="col">part</Th>
                    <Th scope="col">{t("設定")}</Th>
                    <Th scope="col">{t("來源")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {expanded.map((item) => (
                    <tr key={item.path}>
                      <Td className="machine text-fg">{item.path}</Td>
                      <Td className="machine text-fg-secondary">{previewValue(item.settings, 100)}</Td>
                      <Td className="text-caption text-fg-tertiary">
                        {formatList(Object.entries(item.sources)
                          .map(([field, source]) => `${field}←${source === null ? t("共用") : `#${String(source)}`}`))}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
          </Disclosure>
        )}
      </section>

      <section className="grid gap-2" aria-labelledby="part-tree-title">
        <h3 id="part-tree-title" className="text-data font-semibold text-fg">
          {t("子部件樹（{partsCount} 個 part）", { partsCount: parts.length })}
        </h3>
        <ul className="grid gap-0.5">
          {tree.map((node) => (
            <PartTreeNode key={node.path} node={node} depth={0} onAddRule={addRule} disabled={disabled} />
          ))}
        </ul>
      </section>
    </div>
  );
}
