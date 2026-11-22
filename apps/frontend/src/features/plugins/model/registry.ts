// 主控插件登錄表（GET /api/studio/plugins）在前端的索引：引用 → 規則／生成設定與它所屬的包。純函式。
// 登錄表有三種狀態：loading（還沒讀到）、ready、error（讀不到）。只有 ready 而且所屬的包 status 是 ok 的貢獻可以套用；
// 其他情況一律由評估器擋下（fail closed），這裡只負責照實呈現。
import type {
  StudioPlugin,
  StudioPluginGeneration,
  StudioPluginId,
  StudioPluginLimits,
  StudioPluginList,
  StudioPluginPreset,
  StudioPluginRef,
  StudioPluginRule,
} from "@/api/generated/contracts";
import { isRecord } from "@/lib/json";

export type PluginRegistryStatus = "loading" | "ready" | "error";

export interface RegistryRule {
  ref: StudioPluginRef;
  /** 規則內容（比對條件與 inject）的版本；take 記下它來判斷設定是否變更。 */
  rev: string;
  rule: StudioPluginRule;
  plugin: StudioPlugin;
}

export interface RegistryGeneration {
  ref: StudioPluginRef;
  rev: string;
  generation: StudioPluginGeneration;
  plugin: StudioPlugin;
}

export interface RegistryPreset {
  /** 在整份登錄表內唯一：<plugin_id>/<preset id>。 */
  key: string;
  preset: StudioPluginPreset;
  /** 推薦組合解析後的規則引用（同順序）。 */
  refs: readonly StudioPluginRef[];
  plugin: StudioPlugin;
}

export interface PluginRegistry {
  readonly status: PluginRegistryStatus;
  /** 主控回傳的登錄表；還沒讀到或讀不到時為 null。 */
  readonly list: StudioPluginList | null;
  /** 讀不到的原因（status＝error）。 */
  readonly error: unknown;
  /**
   * 重新讀取失敗的原因（status 仍是 ready：內容是上一次讀到的那一份，可能已經不是主控現在的）；沒有失敗時為 null。
   */
  readonly refreshError: unknown;
  readonly plugins: ReadonlyMap<StudioPluginId, StudioPlugin>;
  readonly rules: ReadonlyMap<StudioPluginRef, RegistryRule>;
  readonly generation: ReadonlyMap<StudioPluginRef, RegistryGeneration>;
  readonly presets: readonly RegistryPreset[];
}

const NO_PLUGINS: ReadonlyMap<StudioPluginId, StudioPlugin> = new Map();
const NO_RULES: ReadonlyMap<StudioPluginRef, RegistryRule> = new Map();
const NO_GENERATION: ReadonlyMap<StudioPluginRef, RegistryGeneration> = new Map();
const NO_PRESETS: readonly RegistryPreset[] = [];

/** 還沒讀到登錄表：選了插件貢獻的專案不能渲染。 */
export const LOADING_REGISTRY: PluginRegistry = {
  status: "loading",
  list: null,
  error: null,
  refreshError: null,
  plugins: NO_PLUGINS,
  rules: NO_RULES,
  generation: NO_GENERATION,
  presets: NO_PRESETS,
};

/** 讀不到登錄表（連線失敗、主控回錯誤或格式不對）：選了插件貢獻的專案不能渲染。 */
export function registryFromError(error: unknown): PluginRegistry {
  return { ...LOADING_REGISTRY, status: "error", error };
}

/** 回應是不是登錄表的形狀（只看索引會用到的欄位；內容的合法性由主控負責）。 */
export function isPluginList(value: unknown): value is StudioPluginList {
  if (!isRecord(value) || !Array.isArray(value["items"]) || !isRecord(value["limits"]) || !isRecord(value["host"])) return false;
  return value["items"].every((item) => {
    if (!isRecord(item) || typeof item["plugin_id"] !== "string" || typeof item["status"] !== "string" || !isRecord(item["name"])) return false;
    const contributes = item["contributes"];
    return isRecord(contributes) && Array.isArray(contributes["rules"]) && Array.isArray(contributes["presets"]) && Array.isArray(contributes["generation"]);
  });
}

function buildRegistry(list: StudioPluginList): PluginRegistry {
  const plugins = new Map<StudioPluginId, StudioPlugin>();
  const rules = new Map<StudioPluginRef, RegistryRule>();
  const generation = new Map<StudioPluginRef, RegistryGeneration>();
  const presets: RegistryPreset[] = [];
  for (const plugin of list.items) {
    if (plugins.has(plugin.plugin_id)) continue;
    plugins.set(plugin.plugin_id, plugin);
    // 引用在整份登錄表內唯一（主控保證）；萬一重複，先出現的（內建優先）留下，後面的不會頂替它
    for (const entry of plugin.contributes.rules) {
      if (!rules.has(entry.ref) && !generation.has(entry.ref)) rules.set(entry.ref, { ...entry, plugin });
    }
    for (const entry of plugin.contributes.generation) {
      if (!rules.has(entry.ref) && !generation.has(entry.ref)) generation.set(entry.ref, { ...entry, plugin });
    }
    for (const entry of plugin.contributes.presets) {
      presets.push({ key: `${plugin.plugin_id}/${entry.preset.id}`, preset: entry.preset, refs: entry.refs, plugin });
    }
  }
  return { status: "ready", list, error: null, refreshError: null, plugins, rules, generation, presets };
}

const built = new WeakMap<StudioPluginList, PluginRegistry>();

/** 同一份登錄表永遠得到同一個索引物件（可以直接當 memo 的相依）。 */
export function registryFromList(list: StudioPluginList): PluginRegistry {
  let registry = built.get(list);
  if (!registry) {
    registry = buildRegistry(list);
    built.set(list, registry);
  }
  return registry;
}

const outdated = new WeakMap<StudioPluginList, { error: unknown; registry: PluginRegistry }>();

/** 上一次讀到的登錄表，加上「重新讀取失敗」的原因；同一份登錄表與同一個錯誤得到同一個物件。 */
export function registryFromStaleList(list: StudioPluginList, error: unknown): PluginRegistry {
  const known = outdated.get(list);
  if (known && Object.is(known.error, error)) return known.registry;
  const registry: PluginRegistry = { ...registryFromList(list), refreshError: error };
  outdated.set(list, { error, registry });
  return registry;
}

export type ResolvedRef =
  | { kind: "rule"; entry: RegistryRule }
  | { kind: "generation"; entry: RegistryGeneration }
  /** 登錄表裡沒有這個貢獻；plugin 是引用前綴指到的包（還在登錄表裡時），否則為 null。 */
  | { kind: "missing"; plugin: StudioPlugin | null };

export function resolveRef(registry: PluginRegistry, ref: StudioPluginRef): ResolvedRef {
  const rule = registry.rules.get(ref);
  if (rule) return { kind: "rule", entry: rule };
  const generation = registry.generation.get(ref);
  if (generation) return { kind: "generation", entry: generation };
  // 最後一個「/」之前是包的 id（內建包的引用沒有前綴）；包還在登錄表裡時，呼叫端才能照它的狀態說明原因
  const slash = ref.lastIndexOf("/");
  return { kind: "missing", plugin: slash > 0 ? (registry.plugins.get(ref.slice(0, slash)) ?? null) : null };
}

/** 只有 status 是 ok 的包，貢獻才可以套用。 */
export function pluginUsable(plugin: StudioPlugin): boolean {
  return plugin.status === "ok";
}

/** 一個包可以被專案選用的貢獻（規則與生成設定）的引用，依 manifest 的順序。 */
export function pluginRefs(plugin: StudioPlugin): StudioPluginRef[] {
  return [...plugin.contributes.rules.map((entry) => entry.ref), ...plugin.contributes.generation.map((entry) => entry.ref)];
}

/**
 * 專案的引用裡屬於這個包的那些：登錄表列出的貢獻，加上帶著這個包前綴但已不在包裡的引用（更新後被拿掉的規則），
 * 這樣「在這個專案停用」才會把它們一起清掉。
 */
export function refsOfPlugin(plugin: StudioPlugin, refs: readonly StudioPluginRef[]): StudioPluginRef[] {
  const own = new Set(pluginRefs(plugin));
  const prefix = plugin.source === "builtin" ? null : `${plugin.plugin_id}/`;
  return refs.filter((ref) => own.has(ref) || (prefix !== null && ref.startsWith(prefix)));
}

/** 上限（登錄表提供；還沒讀到時為 null，呼叫端不自己寫死數字）。 */
export function registryLimits(registry: PluginRegistry): StudioPluginLimits | null {
  return registry.list?.limits ?? null;
}
