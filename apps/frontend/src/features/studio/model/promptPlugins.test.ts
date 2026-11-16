// Boundary: a project that selects a plugin contribution cannot render unless the Controller's registry says the
// contribution exists and its package is usable. Planning a render must refuse (never drop the rule and render without
// it) while the registry is unread or unreadable, for unknown references and for disabled, incompatible or invalid
// packages; a usable rule is applied and its content revision is recorded on the take, so a later change of the rule
// marks the take as out of date. The registry is the shared fixture of contracts/examples/plugin-rules.
import registryJson from "@contracts/examples/plugin-rules/registry.json";
import { afterEach, describe, expect, it } from "vitest";
import type { StudioPluginList, StudioProject, StudioShot } from "@/api/generated/contracts";
import type { PluginRegistry } from "@/features/plugins";
import { LOADING_REGISTRY, registryFromError, registryFromList, setCurrentPluginRegistry } from "@/features/plugins/testing";
import { studioProject, studioShot } from "@/test/fixtures";
import { FIXED_TIME, PIPELINE_ID, uid } from "@/test/ids";
import { changedSinceTake } from "./project";
import { applyPromptPlugins, samePlugins, takePluginFields } from "./promptPlugins";
import { planRender, renderTakes } from "./renderPlan";
import { deriveStudioRoutes } from "./routes";
import { exampleCatalog, t2vaPipeline } from "./studioFixtures";

const list = registryJson as unknown as StudioPluginList;
const ready = registryFromList(list);
const catalog = exampleCatalog();
const routes = deriveStudioRoutes([t2vaPipeline()], catalog);

const PROMPT = "detailed_description:\nA swordswoman in the foreground, low-angle, her rival in the deep background.\n[Shot 2] At 2s close-up.\n[Shot 3] At 4s wide shot.";

function project(refs: string[], shot: Partial<StudioShot> = {}): StudioProject {
  return studioProject({ prompt_plugins: refs, shots: [studioShot({ shot_id: "a", title: "A", prompt: PROMPT, route: PIPELINE_ID.t2vaRemoteTe, ...shot })] });
}

function plan(doc: StudioProject, plugins: PluginRegistry) {
  return planRender(doc, doc.shots, ["t1"], { routes, catalog, plugins, randomSeed: () => 7 });
}

describe("render planning with plugin contributions", () => {
  it("renders a project without plugins whatever the registry's state", () => {
    for (const registry of [ready, LOADING_REGISTRY, registryFromError(new Error("offline"))]) expect(plan(project([]), registry).problem).toBeNull();
  });

  it.each([
    ["the registry has not been read yet", LOADING_REGISTRY, "com.example.staging-pack/watercolor"],
    ["the registry cannot be read", registryFromError(new Error("offline")), "com.example.staging-pack/watercolor"],
    ["an unknown reference", ready, "no-such-rule"],
    ["a package that is not installed", ready, "com.example.missing/some-rule"],
    ["a disabled package", ready, "com.example.disabled-pack/soft-light"],
    ["a package for another host version", ready, "com.example.future-pack/future-rule"],
    ["a package with code this version cannot run", ready, "com.example.code-pack/tagged"],
    ["a package whose content cannot be read", ready, "com.example.broken-pack/anything"],
  ])("refuses to plan a render with %s", (_name, registry, ref) => {
    // 另一條可以套用的規則一起選：被拒絕的引用不能讓整個選取被略過
    const result = plan(project([ref, "com.example.staging-pack/padded"]), registry);
    expect(result.plan).toBeNull();
    expect(result.problem).toContain("Prompt 插件");
  });

  it("applies a usable rule to the prompt that is sent, not to the shot", () => {
    const doc = project(["com.example.staging-pack/watercolor", "com.example.staging-pack/no-side-view"]);
    const result = plan(doc, ready);
    expect(result.problem).toBeNull();
    const sent = JSON.stringify(result.plan?.body.inputs);
    expect(sent).toContain("Painted in loose watercolour washes on textured paper.");
    expect(sent).toContain("Staging: the action moves along the depth axis.");
    expect(doc.shots[0]?.prompt).toBe(PROMPT);
  });

  it("refuses a prompt that breaks a selected rule", () => {
    const result = plan(project(["com.example.staging-pack/no-side-view"], { prompt: "A side view of the bridge." }), ready);
    expect(result.plan).toBeNull();
    expect(result.problem).toContain("side view");
  });

  it("refuses when a selected generation setting's requirement is not met, and changes nothing", () => {
    const doc = project(["com.example.dev-pack/tv-720p"]);
    const result = plan(doc, ready);
    expect(result.plan).toBeNull();
    expect(result.problem).toContain("1280×736");
    expect(doc.format).toMatchObject({ width: 768, height: 448 });
    const met = { ...project(["com.example.dev-pack/tv-720p"], { frames: 141 }), format: { width: 1280, height: 736, fps: { num: 24, den: 1 } } };
    expect(plan(met, ready).problem).toBeNull();
  });

  it("cannot check a generation setting without the shot and its route, so it reports that", () => {
    expect(applyPromptPlugins(PROMPT, ["com.example.dev-pack/tv-720p"], undefined, ready).problems).toHaveLength(1);
  });
});

describe("content revisions on takes", () => {
  const refs = ["com.example.staging-pack/watercolor", "com.example.staging-pack/no-side-view"];
  afterEach(() => setCurrentPluginRegistry(null));

  it("records the revision of every selected contribution when a render is planned", () => {
    const doc = project(refs);
    const planned = plan(doc, ready).plan;
    expect(planned?.plugins).toEqual({
      prompt_plugins: refs,
      prompt_plugin_revs: { "com.example.staging-pack/watercolor": ready.rules.get("com.example.staging-pack/watercolor")?.rev, "com.example.staging-pack/no-side-view": "06f3d817b3b5" },
    });
    const takes = planned ? renderTakes(doc, doc.shots, planned, ["t1"], { run_id: uid(3001), created_at: FIXED_TIME }) : [];
    expect(takes[0]?.take.prompt_plugin_revs).toEqual(planned?.plugins.prompt_plugin_revs);
  });

  it("records no revisions while the registry is unknown", () => {
    expect(takePluginFields(refs, LOADING_REGISTRY)).toEqual({ prompt_plugins: refs });
    expect(takePluginFields([], ready)).toEqual({});
  });

  it("marks a take as out of date once a selected rule's content changed", () => {
    const revs = takePluginFields(refs, ready).prompt_plugin_revs;
    expect(samePlugins(refs, [...refs].reverse(), revs, ready)).toBe(true);
    expect(samePlugins(refs, refs, { ...revs, "com.example.staging-pack/watercolor": "000000000000" }, ready)).toBe(false);
    // 沒有記錄版本的舊 take 只比對引用；登錄表還沒讀到時無法比較，不當成變更
    expect(samePlugins(refs, refs, undefined, ready)).toBe(true);
    expect(samePlugins(refs, refs, { ...revs, "com.example.staging-pack/watercolor": "000000000000" }, LOADING_REGISTRY)).toBe(true);
    expect(samePlugins(refs, ["com.example.staging-pack/watercolor"], revs, ready)).toBe(false);
  });

  it("reads the take's revisions when it lists what changed since a take", () => {
    const doc = project(refs);
    const shot = doc.shots[0];
    expect(shot).toBeDefined();
    if (!shot) return;
    const take = {
      take_id: "t1",
      run_id: uid(3001),
      output_key: "final",
      created_at: FIXED_TIME,
      state: "succeeded" as const,
      prompt: shot.prompt,
      seed: shot.seed,
      frames: shot.frames,
      width: doc.format.width,
      height: doc.format.height,
      route: shot.route,
      steps: shot.steps,
      asset: null,
      video_latent: null,
      error: null,
      timings_ms: {},
      prompt_plugins: refs,
    };
    const stale = { ...take, prompt_plugin_revs: { "com.example.staging-pack/watercolor": "000000000000" } };
    // changedSinceTake 讀「目前」的登錄表：還沒讀到時沒有版本可比，只看引用；讀到之後，內容改過的規則讓 take 過期
    expect(changedSinceTake(stale, shot, doc)).toEqual([]);
    expect(changedSinceTake({ ...take, prompt_plugins: ["com.example.staging-pack/watercolor"] }, shot, doc)).toHaveLength(1);
    setCurrentPluginRegistry(ready);
    expect(changedSinceTake(take, shot, doc)).toEqual([]);
    expect(changedSinceTake(stale, shot, doc)).toHaveLength(1);
  });
});
