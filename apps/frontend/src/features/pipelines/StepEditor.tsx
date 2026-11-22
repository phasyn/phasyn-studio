import { withOccurrenceKeys } from "@/lib/occurrenceKeys";
import { isWireBindings } from "@/api/types";
import { ArrowDown, ArrowUp, ArrowUpRight, CircleAlert, Plus, Trash } from "lucide-react";
import { useId, useState } from "react";
import type { Port } from "@/api/generated/contracts";
import type { WireBinding, WirePipeline, WireStep } from "@/api/types";
import { CommitInput } from "@/components/common/CommitInput";
import { Disclosure } from "@/components/common/Disclosure";
import { JsonEditor } from "@/components/common/JsonEditor";
import { ParametersEditor } from "@/components/common/ParametersEditor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/controls";
import { CHIP_TONE, type Tone } from "@/components/workbench/tones";
import { typeTone } from "@/components/workbench/kinds";
import { DIT_PROVIDER, formatSampling, SAMPLING_KEYS, storedSampling } from "@/lib/ditSampling";
import { localIdError } from "@/lib/ids";
import { isListed, withRecordValue, isRecord } from "@/lib/json";
import { cn } from "@/lib/cn";
import { validateValue } from "@/lib/schema";
import type { ComponentEntry } from "@/api/catalog";
import { optionValue, type ComponentOption } from "./catalogIndex";
import { InstancePicker } from "./InstancePicker";
import { bindingKind, bindingType, outputValue, parseOutputValue, sourceOptions, withComponent, type DescriptorLookup, type PipelineIssue } from "./pipelineModel";
import { reveal } from "@/components/ui/motion";
import { ACTIVE_CARD_EDGE } from "./presentation";
import { TypedValueInput } from "./TypedValueInput";
import { t } from "@/i18n";
import { T } from "@/i18n/T";
import { formatList } from "@/i18n/format";

type SourceKind = "none" | "input" | "step" | "literal";

function BindingRow({
  idBase,
  stepId,
  stepIndex,
  port,
  binding,
  pipeline,
  lookup,
  onChange,
  onAddInput,
  stacked = false,
}: {
  /** The step editor's id prefix (unique per editor). */
  idBase: string;
  stepId: string;
  stepIndex: number;
  port: Port;
  binding: WireBinding | undefined;
  pipeline: WirePipeline;
  lookup: DescriptorLookup;
  onChange: (next: WireBinding | undefined) => void;
  /** 以此埠的型別建立 pipeline 輸入，回傳名稱。 */
  onAddInput: (port: Port) => string;
  /** 窄欄（Inspector）：來源種類與來源選單上下排列。 */
  stacked?: boolean;
}) {
  const kind: SourceKind = binding ? bindingKind(binding) : "none";
  const sources = sourceOptions(pipeline, stepIndex, port, lookup);
  const got = binding ? bindingType(binding, pipeline, lookup) : null;
  const mismatch = got !== null && got !== port.type_id;
  const baseId = `${idBase}-port-${port.name.replace(/[^A-Za-z0-9_-]/g, "-")}`;

  const switchKind = (next: SourceKind) => {
    if (next === "none") onChange(undefined);
    else if (next === "input") {
      const compatible = sources.inputs.find((option) => option.compatible);
      onChange({ from_input: compatible ? compatible.value : onAddInput(port) });
    } else if (next === "step") {
      const compatible = sources.outputs.find((option) => option.compatible);
      const parsed = compatible ? parseOutputValue(compatible.value) : null;
      onChange({ from_step: parsed?.stepId ?? "", output: parsed?.output ?? "" });
    } else {
      onChange({ literal: { type_id: port.type_id, value: null } });
    }
  };

  const currentStepValue = binding && "from_step" in binding ? outputValue(binding.from_step, binding.output) : "";
  return (
    <div className="grid min-w-0 gap-2 rounded-md border border-line-subtle bg-sunken/40 p-3" data-port={port.name}>
      <p className="flex flex-wrap items-center gap-2 text-data">
        <code className="machine text-fg">{port.name}</code>
        <code className="machine text-caption text-file">{port.type_id}</code>
        <Badge>{port.required ? t("必填") : t("選填")}</Badge>
        <span className="machine text-caption text-fg-tertiary">{port.transport}</span>
      </p>
      {port.description ? <p className="text-caption text-fg-tertiary">{port.description}</p> : null}
      <div className={cn("grid gap-2", !stacked && "sm:grid-cols-[11rem_minmax(0,1fr)]")}>
        <Select id={`${baseId}-kind`} aria-label={t("{stepId}.{name} 的來源類型", { stepId, name: port.name })} value={kind} onChange={(event) => { const value = event.target.value; if (isListed(value, ["none", "input", "step", "literal"] as const)) switchKind(value); }}>
          <option value="none">{port.required ? t("未接（必填）") : t("不接（選填）")}</option>
          <option value="input">{t("pipeline 輸入")}</option>
          <option value="step">{t("步驟輸出")}</option>
          <option value="literal">{t("常值")}</option>
        </Select>
        {binding && "from_input" in binding ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="min-w-40 flex-1">
              <Select
                id={`${baseId}-input`}
                aria-label={t("{stepId}.{name} 接到哪個 pipeline 輸入", { stepId, name: port.name })}
                value={binding.from_input}
                onChange={(event) => { onChange({ from_input: event.target.value }); }}
              >
                {!sources.inputs.some((option) => option.value === binding.from_input) ? (
                  <option value={binding.from_input}>{t("{value}（不存在）", { value: binding.from_input || t("（未選擇）") })}</option>
                ) : null}
                {sources.inputs.map((option) => (
                  <option key={option.value} value={option.value} disabled={!option.compatible && option.value !== binding.from_input}>
                    {option.label} · {option.typeId}
                    {(option.reason != null && option.reason !== "") ? t("（不可用：{reason}）", { reason: option.reason }) : ""}
                  </option>
                ))}
              </Select>
            </div>
            <Button size="sm" variant="quiet" icon={<Plus aria-hidden />} onClick={() => { onChange({ from_input: onAddInput(port) }); }}>
              {t("新增同型別輸入")}
            </Button>
          </div>
        ) : binding && "from_step" in binding ? (
          <Select
            id={`${baseId}-step`}
            aria-label={t("{stepId}.{name} 接到哪個步驟輸出", { stepId, name: port.name })}
            value={currentStepValue}
            onChange={(event) => {
              const parsed = parseOutputValue(event.target.value);
              if (parsed) onChange({ from_step: parsed.stepId, output: parsed.output });
            }}
          >
            {!sources.outputs.some((option) => option.value === currentStepValue) ? (
              <option value={currentStepValue}>{binding.from_step ? t("{from_step}.{output}（不存在）", { from_step: binding.from_step, output: binding.output }) : t("（沒有相容的步驟輸出）")}</option>
            ) : null}
            {sources.outputs.map((option) => (
              <option key={option.value} value={option.value} disabled={!option.compatible && option.value !== currentStepValue}>
                {option.label}
                {(option.typeId != null && option.typeId !== "") ? ` · ${option.typeId}` : ""}
                {(option.reason != null && option.reason !== "") ? t("（不可用：{reason}）", { reason: option.reason }) : ""}
              </option>
            ))}
          </Select>
        ) : binding && "literal" in binding ? (
          <p className="self-center text-caption text-fg-tertiary">{t("常值固定寫在流程中；每次 run 都使用同一份。")}</p>
        ) : (
          <p className={port.required ? "self-center text-caption text-danger" : "self-center text-caption text-fg-tertiary"}>
            {port.required ? t("必填輸入尚未接線") : t("不接：元件依自己的預設處理")}
          </p>
        )}
      </div>
      {binding && "literal" in binding ? (
        <TypedValueInput
          id={`${baseId}-literal`}
          label={t("{stepId}.{name} 常值", { stepId, name: port.name })}
          typeId={port.type_id}
          transport={port.transport}
          required
          value={binding.literal}
          onChange={(next) => { onChange({ literal: next ?? { type_id: port.type_id, value: null } }); }}
        />
      ) : null}
      {mismatch ? (
        <p className="flex items-center gap-1.5 text-caption text-danger">
          <CircleAlert aria-hidden className="size-3.5" />
          {t("型別不符：需要 {type_id}，接到 {got}；不做自動轉換。", { type_id: port.type_id, got })}
        </p>
      ) : null}
    </div>
  );
}

/** 步驟輸出接點上的流程輸出（名稱依接點）與操作；沒有提供時不顯示。 */
export interface StepExports {
  /** 輸出埠 → 這個接點被宣告成的流程輸出名稱。 */
  byPort: Readonly<Record<string, readonly string[]>>;
  /** 把這個輸出埠宣告為流程輸出。 */
  onAdd: (port: Port) => void;
  /** 選取流程輸出（在檢視器改名、改來源或移除）。 */
  onSelect: (name: string) => void;
}

function OutputPorts({ ports, exports, stepId }: { ports: readonly Port[]; exports?: StepExports; stepId: string }) {
  if (ports.length === 0) return <p className="text-caption text-fg-tertiary">{t("此元件沒有輸出埠。")}</p>;
  return (
    <ul className="grid gap-1" aria-label={t("{stepId} 的輸出與流程輸出", { stepId })}>
      {ports.map((port) => {
        const names = exports?.byPort[port.name] ?? [];
        const tone: Tone = typeTone(port.type_id);
        return (
          <li key={port.name} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption">
            <code className="machine text-fg">{port.name}</code>
            <code className={cn("machine rounded-sm border px-1", CHIP_TONE[tone])}>{port.type_id}</code>
            {exports
              ? names.map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => { exports.onSelect(name); }}
                    title={t("流程輸出 {name}：點選可改名、改來源或移除", { name })}
                    className="pressable inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface px-1.5 text-fg-secondary hover:border-brand-blue/60 hover:bg-raised hover:text-fg"
                  >
                    <ArrowUpRight aria-hidden className="size-3" />
                    <span className="machine">{name}</span>
                    <span className="sr-only">{t("（流程輸出，點選編輯）")}</span>
                  </button>
                ))
              : null}
            {exports && names.length === 0 ? (
              <Button size="sm" variant="quiet" icon={<Plus aria-hidden />} className="min-h-6 px-1.5 text-caption" onClick={() => { exports.onAdd(port); }}>
                {t("設為流程輸出")}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** 單一步驟：元件 instance（同 provider 的相容 instance，或元件庫）、每個輸入埠的來源、輸出與流程輸出、呼叫參數與進階欄位。 */
export function StepEditor({
  step,
  index,
  count,
  pipeline,
  lookup,
  options,
  issues,
  onChange,
  onRename,
  onMove,
  onRemove,
  onAddInput,
  exports,
  nodeLabel,
  variant = "card",
  appear = 0,
}: {
  step: WireStep;
  index: number;
  count: number;
  pipeline: WirePipeline;
  lookup: DescriptorLookup;
  options: readonly ComponentOption[];
  issues: readonly PipelineIssue[];
  onChange: (next: WireStep) => void;
  onRename: (next: string) => string | null;
  onMove: (to: number) => void;
  onRemove: () => void;
  onAddInput: (port: Port) => string;
  /** 選填：在輸出埠旁顯示／新增流程輸出。 */
  exports?: StepExports;
  /** 選填：Node 顯示名稱（未知元件的說明用）。 */
  nodeLabel?: (nodeId: string) => string | null;
  /** card：步驟清單中的卡片（li）；inspector：右側屬性檢視器內的直排版面（div、無外框）。 */
  variant?: "card" | "inspector";
  /** 卡片在清單中的順序（第一次出現時依序淡入；只用於 card）。 */
  appear?: number;
}) {
  const inspector = variant === "inspector";
  const Root = inspector ? "div" : "li";
  // The selected step is edited both in the step list and in the inspector: element ids (and the labels pointing at
  // them) must be unique per editor, not per step.
  const editorId = useId();
  const idBase = `${editorId}step-${String(index)}`;
  const [swapNote, setSwapNote] = useState<string | null>(null);
  const descriptor = step.node_id && step.component_id ? lookup(step.node_id, step.component_id) : null;
  const current = step.node_id && step.component_id ? optionValue(step.node_id, step.component_id) : "";
  const entries: ComponentEntry[] = options.map((item) => ({ descriptor: item.descriptor, node: item.node, key: item.value }));
  const currentEntry = entries.find((item) => item.key === current) ?? null;
  // 參數問題由下方的參數表單在欄位旁顯示（不重複列出）
  const stepIssues = issues.filter((issue) => issue.stepId === step.step_id && issue.parameter === undefined);
  const paramsSchema = descriptor?.settings.parameters_schema ?? {};
  const paramIssues = descriptor ? validateValue(paramsSchema, step.parameters, isRecord(paramsSchema) ? paramsSchema : undefined) : [];
  const knownPorts = new Set(descriptor?.inputs.map((port) => port.name) ?? []);
  const strayPorts = descriptor ? Object.keys(step.inputs).filter((port) => !knownPorts.has(port)) : [];

  const chooseComponent = (entry: ComponentEntry) => {
    const next = withComponent(step, descriptor, entry.node.node_id, entry.descriptor);
    const removed = Object.fromEntries(SAMPLING_KEYS.filter((key) => step.parameters[key] !== undefined && next.parameters[key] === undefined).map((key) => [key, step.parameters[key]]));
    setSwapNote(
      entry.descriptor.provider_id === DIT_PROVIDER && Object.keys(removed).length > 0
        ? t("已移除上一個 DiT 的採樣參數（{removed}），改用 {component_id} 保存的預設（{value}）", { removed: formatSampling(removed), component_id: entry.descriptor.component_id, value: formatSampling(storedSampling(entry.descriptor)) || t("元件內建") })
        : null,
    );
    onChange(next);
  };

  return (
    <Root
      className={cn("grid min-w-0 gap-4", inspector ? "p-3" : cn("panel p-4", ACTIVE_CARD_EDGE))}
      ref={inspector ? undefined : reveal(appear)}
      aria-label={t("步驟 {index}：{step_id}", { index: index + 1, step_id: step.step_id })}
    >
      <div className={cn("flex flex-wrap items-start gap-3", inspector && "grid grid-cols-[minmax(0,1fr)_auto] gap-2")}>
        <span className={cn("machine pt-2.5 text-caption text-fg-tertiary", inspector && "hidden")}>#{index + 1}</span>
        <div className={cn("grid gap-1", inspector ? "min-w-0" : "w-44")}>
          <span className="text-caption text-fg-secondary">step_id</span>
          <CommitInput id={`${idBase}-id`} label={t("步驟 {index} 的 step_id", { index: index + 1 })} value={step.step_id} onCommit={onRename} />
        </div>
        {!inspector ? <span aria-hidden className="flex-1" /> : null}
        <span className={cn("flex items-center gap-1", inspector ? "col-start-2 row-start-1 pt-5" : "pt-6")}>
          <Button size="icon-sm" variant="quiet" aria-label={t("步驟 {step_id} 上移", { step_id: step.step_id })} disabled={index === 0} onClick={() => { onMove(index - 1); }}>
            <ArrowUp aria-hidden />
          </Button>
          <Button size="icon-sm" variant="quiet" aria-label={t("步驟 {step_id} 下移", { step_id: step.step_id })} disabled={index === count - 1} onClick={() => { onMove(index + 1); }}>
            <ArrowDown aria-hidden />
          </Button>
          <Button size="icon-sm" variant="danger" aria-label={t("刪除步驟 {step_id}", { step_id: step.step_id })} onClick={onRemove}>
            <Trash aria-hidden />
          </Button>
        </span>
      </div>
      <InstancePicker
        stepId={step.step_id}
        current={currentEntry}
        currentNodeId={step.node_id}
        currentComponentId={step.component_id}
        currentNodeLabel={step.node_id ? (nodeLabel?.(step.node_id) ?? null) : null}
        entries={entries}
        onChoose={chooseComponent}
      />
      {(swapNote != null && swapNote !== "") ? (
        <p role="status" className="text-caption text-info">
          {swapNote}
        </p>
      ) : null}
      {stepIssues.length > 0 ? (
        <ul className="grid gap-1" aria-label={t("步驟 {step_id} 的接線問題", { step_id: step.step_id })}>
          {withOccurrenceKeys(stepIssues, (issue) => issue.message).map(({ item: issue, key }) => (
            <li key={key} className={issue.severity === "error" ? "text-caption text-danger" : "text-caption text-warning"}>
              {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
      {descriptor ? (
        <div className={cn("grid min-w-0 gap-4", !inspector && "xl:grid-cols-2")}>
          <section className="grid min-w-0 content-start gap-2" aria-label={t("{step_id} 的輸入接線", { step_id: step.step_id })}>
            <h4 className="text-data font-semibold text-fg">{t("輸入接線（{inputsCount}）", { inputsCount: descriptor.inputs.length })}</h4>
            {descriptor.inputs.length === 0 ? <p className="text-caption text-fg-tertiary">{t("此元件沒有輸入埠。")}</p> : null}
            {descriptor.inputs.map((port) => (
              <BindingRow
                key={port.name}
                idBase={idBase}
                stepId={step.step_id}
                stepIndex={index}
                port={port}
                binding={step.inputs[port.name]}
                pipeline={pipeline}
                lookup={lookup}
                onAddInput={onAddInput}
                stacked={inspector}
                onChange={(next) => {
                  onChange({ ...step, inputs: withRecordValue(step.inputs, port.name, next ?? undefined) });
                }}
              />
            ))}
            {strayPorts.length > 0 ? (
              <p className="flex flex-wrap items-center gap-2 text-caption text-danger">
                <T source={"元件沒有這些輸入：{strayPorts}<0>移除</0>"} values={{ strayPorts: formatList(strayPorts) }} slots={[<Button key="slot-0"
                  size="sm"
                  variant="quiet"
                  onClick={() => {
                    const inputs = Object.fromEntries(Object.entries(step.inputs).filter(([name]) => !strayPorts.includes(name)));
                    onChange({ ...step, inputs });
                  }} />]} />
              </p>
            ) : null}
            <h4 className="mt-1 text-data font-semibold text-fg">{t("輸出（{outputsCount}）", { outputsCount: descriptor.outputs.length })}</h4>
            <OutputPorts ports={descriptor.outputs} {...(exports === undefined ? {} : { exports })} stepId={step.step_id} />
          </section>
          <section className="grid min-w-0 content-start gap-2" aria-label={t("{step_id} 的呼叫參數", { step_id: step.step_id })}>
            <ParametersEditor
              schema={paramsSchema}
              value={step.parameters}
              onChange={(next) => { onChange({ ...step, parameters: next }); }}
              idPrefix={`${idBase}-params`}
              issues={paramIssues}
              label={t("呼叫參數（parameters_schema）")}
            />
          </section>
        </div>
      ) : step.component_id ? (
        <div className="grid gap-3">
          <p className="text-caption text-warning">{t("未知元件：目錄中沒有它的描述，無法提供連接埠選單；以下以 JSON 直接編輯，或在上方改選其他 instance。")}</p>
          <JsonEditor
            id={`${idBase}-inputs-json`}
            label={t("inputs（JSON）")}
            value={step.inputs}
            accept={(next) => (isWireBindings(next) ? null : t("schema 不允許此值"))}
            onChange={(next) => { if (isWireBindings(next)) onChange({ ...step, inputs: next }); }}
            rows={4}
          />
          <JsonEditor
            id={`${idBase}-params-json`}
            label={t("parameters（JSON）")}
            value={step.parameters}
            accept={(next) => (isRecord(next) ? null : t("parameters 必須是 object"))}
            onChange={(next) => { if (isRecord(next)) onChange({ ...step, parameters: next }); }}
            rows={4}
          />
        </div>
      ) : (
        <p className="text-caption text-fg-tertiary">{t("選擇 instance 後會列出它的輸入埠、輸出與參數表單。")}</p>
      )}
      <Disclosure summary={t("進階：要求的 loaded revision、逾時")}>
        <div className={cn("grid gap-3", !inspector && "sm:grid-cols-2")}>
          <div className="grid gap-1">
            <label htmlFor={`${idBase}-revision`} className="text-caption text-fg-secondary">
              {t("load_revision（選填；Node 已載入其他 revision 時回 SETTINGS_NOT_LOADED，不會暗中換模型）")}
            </label>
            <Input
              id={`${idBase}-revision`}
              className="machine"
              inputMode="numeric"
              value={step.load_revision === null || step.load_revision === undefined ? "" : String(step.load_revision)}
              placeholder={(descriptor?.settings.loaded_revision != null && Boolean(descriptor.settings.loaded_revision)) ? t("目前載入 #{loaded_revision}", { loaded_revision: descriptor.settings.loaded_revision }) : t("不指定")}
              onChange={(event) => {
                const raw = event.target.value.trim();
                const next = { ...step };
                if (raw === "") delete next.load_revision;
                else if (/^\d+$/.test(raw)) next.load_revision = Number(raw);
                else return;
                onChange(next);
              }}
            />
          </div>
          <div className="grid gap-1">
            <label htmlFor={`${idBase}-timeout`} className="text-caption text-fg-secondary">
              {t("timeout_seconds（選填；預設 7200）")}
            </label>
            <Input
              id={`${idBase}-timeout`}
              className="machine"
              inputMode="numeric"
              value={step.timeout_seconds === undefined ? "" : String(step.timeout_seconds)}
              placeholder="7200"
              onChange={(event) => {
                const raw = event.target.value.trim();
                const next = { ...step };
                if (raw === "") delete next.timeout_seconds;
                else if (/^\d+$/.test(raw) && Number(raw) >= 1) next.timeout_seconds = Number(raw);
                else return;
                onChange(next);
              }}
            />
          </div>
        </div>
        {((localIdError(step.step_id) ?? "") !== "") ? <p className="mt-2 text-caption text-danger">{localIdError(step.step_id, "step_id ")}</p> : null}
      </Disclosure>
    </Root>
  );
}
