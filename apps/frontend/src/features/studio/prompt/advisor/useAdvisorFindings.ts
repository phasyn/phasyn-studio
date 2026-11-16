// 面板與徽章共用：以延遲的文字（useDeferredValue）分析，打字時不卡；stale＝分析的還是前一版文字。
import { useDeferredValue, useMemo } from "react";
import { analyzePrompt } from "./analyze";
import type { AnalyzeInput, Finding } from "./types";

export function useAdvisorFindings(input: AnalyzeInput): { findings: Finding[]; stale: boolean } {
  const text = useDeferredValue(input.text);
  const { mode, frames, references, library, firstFrame } = input;
  const findings = useMemo(() => analyzePrompt({ text, mode, frames, references, library, firstFrame }), [text, mode, frames, references, library, firstFrame]);
  return { findings, stale: text !== input.text };
}
