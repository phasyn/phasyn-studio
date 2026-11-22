// Transcription asks for Traditional Chinese when the transcriber can produce it, and leaves older transcribers alone.
import { describe, expect, it } from "vitest";
import { indexCatalog } from "@/api/catalog";
import { catalog, descriptor } from "@/test/fixtures/catalog";
import { pipeline, step } from "@/test/fixtures/pipeline";
import { NODE_A_ID } from "@/test/ids";
import type { TranscribeRoute } from "./dialogueRoutes";
import { withTraditionalChinese } from "./transcribe";

function route(parametersSchema: Record<string, unknown>, parameters: Record<string, unknown> = {}): TranscribeRoute {
  const asr = descriptor(NODE_A_ID, "transcribe-local", "media.transcribe", { parametersSchema });
  const entry = indexCatalog(catalog([asr])).entry(NODE_A_ID, "transcribe-local");
  if (!entry) throw new Error("fixture");
  return { pipeline: pipeline("transcribe-local", [step("transcribe", NODE_A_ID, "transcribe-local", {}, parameters)]), entry, inputs: { video: "video", audio: "audio" }, outputKey: "transcript" };
}

describe("withTraditionalChinese", () => {
  it("asks a transcriber that knows chinese_script for Traditional Chinese", () => {
    const steps = withTraditionalChinese(route({ properties: { chinese_script: {}, language: {} } }, { vad: true })).steps;
    expect(steps[0]?.parameters).toEqual({ chinese_script: "traditional", vad: true });
  });

  it("keeps a saved pipeline's own choice", () => {
    const steps = withTraditionalChinese(route({ properties: { chinese_script: {} } }, { chinese_script: null })).steps;
    expect(steps[0]?.parameters).toEqual({ chinese_script: null });
  });

  it("sends nothing new to a transcriber without the parameter (it would refuse it)", () => {
    const original = route({ properties: { language: {} } });
    expect(withTraditionalChinese(original)).toBe(original.pipeline);
  });
});
