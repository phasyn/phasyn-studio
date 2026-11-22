import { describe, expect, it } from "vitest";
import type { WirePipeline } from "@/api/types";
import { fixTool, restoreShortSide, sourceShortSide, toolPipeline, type FixSource, type PipelineTool } from "./tools";

const NODE = "00000000-0000-4000-8000-000000000001";

function pipeline(id: string, stepId: string, parameters: Record<string, unknown>): WirePipeline {
  return {
    pipeline_id: id,
    label: id,
    inputs: [],
    outputs: { final: { from_step: stepId, output: "asset" } },
    steps: [
      { step_id: "probe", node_id: NODE, component_id: "probe", inputs: {}, parameters: {} },
      { step_id: stepId, node_id: NODE, component_id: "c", inputs: {}, parameters },
    ],
  };
}

function pipelineTool(id: string): PipelineTool {
  const tool = fixTool(id);
  if (tool?.kind !== "pipeline") throw new Error(id);
  return tool;
}

describe("fix tools", () => {
  it("extends deliver the original and the extension as one take", () => {
    for (const id of ["extend-after", "extend-before"]) {
      const run = toolPipeline(pipelineTool(id), pipeline("wan-edit-extend-after", "edit", { frames: 24, operation: "extend_after" }));
      const edit = run.steps.find((step) => step.step_id === "edit");
      expect(edit?.parameters).toEqual({ frames: 24, operation: "extend_after", deliver: "joined" });
      expect(run.steps.find((step) => step.step_id === "probe")?.parameters).toEqual({});
    }
  });

  it("the soundtrack replacement converts any chosen audio before the mux", () => {
    const saved = pipeline("soundtrack-take-local", "mux", { audio_codec: "aac" });
    const run = toolPipeline(pipelineTool("soundtrack"), saved);
    expect(run.steps.find((step) => step.step_id === "mux")?.parameters).toEqual({ audio_codec: "aac", audio_fit: "conform" });
    expect(saved.steps[1]?.parameters).toEqual({ audio_codec: "aac" }); // the saved pipeline is not changed
  });

  it("a tool without parameters runs the saved pipeline as it is", () => {
    const saved = pipeline("upscale-take-2x", "upscale", { steps: 1 });
    expect(toolPipeline(pipelineTool("upscale"), saved, videoSource(1280, 736))).toBe(saved);
  });

  it("the restore runs at the source video's own short side", () => {
    const saved = pipeline("restore-take-local", "restore", { short_side: 736, seed: 42 });
    const run = toolPipeline(pipelineTool("restore"), saved, videoSource(1920, 1080));
    expect(run.steps.find((step) => step.step_id === "restore")?.parameters).toEqual({ short_side: 1080, seed: 42 });
    expect(run.steps.find((step) => step.step_id === "probe")?.parameters).toEqual({});
    expect(saved.steps[1]?.parameters).toEqual({ short_side: 736, seed: 42 }); // the saved pipeline is not changed
  });

  it("restore and interpolate restores at the source's short side, whichever step delivers", () => {
    const saved = pipeline("finish-take-local", "interpolate", { multiplier: 2 });
    saved.steps.push({ step_id: "restore", node_id: NODE, component_id: "restore", inputs: {}, parameters: { short_side: 736 } });
    const run = toolPipeline(pipelineTool("finish"), saved, videoSource(1280, 720));
    expect(run.steps.find((step) => step.step_id === "restore")?.parameters).toEqual({ short_side: 720 });
    expect(run.steps.find((step) => step.step_id === "interpolate")?.parameters).toEqual({ multiplier: 2 });
  });

  it("a source of unknown size keeps the saved short side", () => {
    const saved = pipeline("restore-take-local", "restore", { short_side: 736 });
    expect(toolPipeline(pipelineTool("restore"), saved, videoSource(null, null))).toBe(saved);
    expect(toolPipeline(pipelineTool("restore"), saved)).toBe(saved);
  });

  it("the short side is even and within the restorer's bounds", () => {
    expect(sourceShortSide(videoSource(1280, 736))).toBe(736);
    expect(restoreShortSide(721, 1281)).toBe(720);
    expect(restoreShortSide(64, 96)).toBe(128);
    expect(restoreShortSide(3840, 2160)).toBe(1536);
    expect(restoreShortSide(0, 720)).toBeNull();
    expect(restoreShortSide(null, 720)).toBeNull();
  });
});

/** A video of the project library of this size. */
function videoSource(width: number | null, height: number | null): FixSource {
  return {
    kind: "library",
    item: {
      item_id: "00000000-0000-4000-8000-0000000000b1",
      kind: "video",
      name: "clip",
      file: { node_id: NODE, file_id: "00000000-0000-4000-8000-0000000000b2", media_type: "video/mp4", size_bytes: 1, sha256: "0".repeat(64), metadata: {} },
      created_at: "2026-11-22T00:00:00.000Z",
      duration_seconds: 5,
      width,
      height,
      has_audio: true,
    },
  };
}
