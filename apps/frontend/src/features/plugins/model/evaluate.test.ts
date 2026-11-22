import { isListed } from "@/lib/json";
import { contractFixture, fixtureValue } from "@/test/fixtures";
// Boundary: the rule evaluator never lets a render through that a selected plugin contribution should stop (fail
// closed), and it gives the same result as the reference evaluator. Every shared case of
// contracts/examples/plugin-rules (the rules are , "Evaluating rules") runs here against the fixture
// registry, which holds packages in every state: ok, disabled, incompatible (three reasons), invalid and development.
import generationVectors from "@contracts/examples/plugin-rules/generation.json";
import promptVectors from "@contracts/examples/plugin-rules/prompt-rules.json";
import registryJson from "@contracts/examples/plugin-rules/registry.json";
import { describe, expect, it } from "vitest";
import type { StudioPluginList } from "@/api/generated/contracts";
import { evaluateSelection, resolveSelection, type RuleFinding } from "./evaluate";
import { checkGeneration, type GenerationActuals } from "./generation";
import { isPluginList, LOADING_REGISTRY, registryFromError, registryFromList, type PluginRegistry } from "./registry";

/** Which shot or subject a per-shot finding is about (absent for a check of the whole prompt). */
interface Place {
  shot?: number;
  subject?: number;
}

interface Expected {
  problems: Record<string, unknown>[];
  forbidden: ({ ref: string; check: string; match: string } & Place)[];
  missing: ({ ref: string; check: string } & Place)[];
  unmet?: { ref: string; check: string }[];
  prompt: string;
  blocked: boolean;
}


const list = contractFixture("StudioPluginList", registryJson);
const ready = registryFromList(list);
const unavailable = registryFromError(new Error("registry unavailable"));

function place(item: RuleFinding): Place {
  return { ...(item.shot === null ? {} : { shot: item.shot }), ...(item.subject === null ? {} : { subject: item.subject }) };
}

/** The evaluator's result in the shape of the shared cases. */
function evaluate(registry: PluginRegistry, refs: readonly string[], prompt: string, settings?: GenerationActuals): Required<Expected> {
  const selection = resolveSelection(registry, refs);
  const evaluation = evaluateSelection(selection, prompt);
  const unmet = settings ? checkGeneration(selection.generation, settings) : [];
  return {
    problems: selection.problems.map((problem) => ({ code: problem.code, ...(problem.ref === null ? {} : { ref: problem.ref }), ...problem.details })),
    forbidden: evaluation.findings.flatMap((item) => (item.kind === "forbid" && item.match !== null ? [{ ref: item.ref, check: item.itemId, match: item.match, ...place(item) }] : [])),
    missing: evaluation.findings.flatMap((item) => (item.kind === "require" ? [{ ref: item.ref, check: item.itemId, ...place(item) }] : [])),
    unmet: unmet.map((item) => ({ ref: item.ref, check: item.requirementId })),
    prompt: evaluation.prompt,
    blocked: evaluation.blocked || unmet.length > 0,
  };
}

function generationActuals(settings: Omit<GenerationActuals, "route_capability"> & { route_capability: string | null }): GenerationActuals {
  const route = settings.route_capability;
  if (route !== null && !isListed(route, ["t2va", "fl2va", "ref2va"] as const)) throw new Error("Unknown generation vector capability");
  return { ...settings, route_capability: route };
}

describe("plugin rule evaluation: shared cases", () => {
  it("reads the fixture registry as a plugin registry", () => {
    expect(isPluginList(registryJson)).toBe(true);
    expect([...new Set(list.items.map((plugin) => plugin.status))].sort()).toEqual(["disabled", "incompatible", "invalid", "ok"]);
  });

  it.each(promptVectors.cases.map((item) => [item.name, item] as const))("prompt rules: %s", (_name, item) => {
    const registry = item.registry === "unavailable" ? unavailable : ready;
    expect(evaluate(registry, item.plugins, item.prompt)).toEqual({ unmet: [], ...item.expect });
  });

  it.each(generationVectors.cases.map((item) => [item.name, item] as const))("generation settings: %s", (_name, item) => {
    const registry = "registry" in item && item.registry === "unavailable" ? unavailable : ready;
    expect(evaluate(registry, item.plugins, item.prompt, generationActuals(item.settings))).toEqual(item.expect);
  });
});

describe("plugin rule evaluation: fail closed", () => {
  const PROMPT = "A fox runs through fresh snow.";

  it("blocks while the registry has not been read yet, and leaves the prompt alone", () => {
    const result = evaluate(LOADING_REGISTRY, ["com.example.staging-pack/watercolor"], PROMPT);
    expect(result).toMatchObject({ blocked: true, prompt: PROMPT, problems: [{ code: "registry_unavailable" }] });
  });

  it("never applies a contribution whose package is not ok", () => {
    for (const plugin of list.items.filter((item) => item.status !== "ok")) {
      for (const entry of plugin.contributes.rules) {
        const result = evaluate(ready, [entry.ref], PROMPT);
        expect(result.blocked, entry.ref).toBe(true);
        expect(result.prompt, entry.ref).toBe(PROMPT);
        expect(result.problems, entry.ref).toEqual([{ code: `plugin_${plugin.status}`, ref: entry.ref, plugin_id: plugin.plugin_id }]);
      }
    }
  });

  it("never compiles a regular expression of a package that is not built in", () => {
    const hostile: StudioPluginList = {
      ...list,
      items: [
        {
          ...fixtureValue(list.items.find((plugin) => plugin.plugin_id === "com.example.staging-pack"), "evaluate.test.ts"),
          contributes: {
            rules: [
              {
                ref: "com.example.staging-pack/slow",
                rev: "000000000000",
                rule: { id: "slow", kind: "constraint", label: { en: "Slow" }, forbid: [{ id: "x", pattern: "(a+)+$", message: { en: "x" } }] },
              },
            ],
            presets: [],
            generation: [],
            commands: [],
            panels: [],
          },
        },
      ],
    };
    const result = evaluate(registryFromList(hostile), ["com.example.staging-pack/slow"], `${"a".repeat(64)}!`);
    expect(result.blocked).toBe(true);
    expect(result.problems).toMatchObject([{ code: "rule_unusable", ref: "com.example.staging-pack/slow" }]);
  });

  it("checks a generation requirement against an unknown field as unmet", () => {
    const entry = ready.generation.get("com.example.dev-pack/reference-route");
    expect(entry).toBeDefined();
    const none: GenerationActuals = { format: null, frames: null, steps: null, video_shift: null, audio_shift: null, route_capability: null, reference_video_short_edge: null };
    expect(checkGeneration(entry ? [entry] : [], none).map((item) => item.requirementId)).toEqual(["capability", "short-edge"]);
  });
});
