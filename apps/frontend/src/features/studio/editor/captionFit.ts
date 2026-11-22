// Captions at the same position never overlap (the preview would stack them unreadably). The same rule as the
// Controller's timeline commands (packages/components/.../timeline_edit/caption_fit.py), so an edit made here and one an
// agent makes through phasynctl give the same document: within one position a caption that runs into the next one ends
// where the next one starts; two that start on the same frame play one after the other (the later one in the list
// moves after the earlier one, keeping its length). A generated caption whose times are still the generated ones keeps
// its transcription record in step. Captions at different positions (top and bottom) may overlap.
import type { TimelineCaption } from "@/api/generated/contracts";
import { MAX_SEQUENCE_FRAMES } from "@/api/generated/timelineLimits";

function overlap(captions: readonly TimelineCaption[]): [number, number] | null {
  const order = captions.map((_, index) => index).sort((a, b) => {
    const left = captions[a];
    const right = captions[b];
    if (!left || !right) return 0;
    return left.position.localeCompare(right.position) || left.start_frame - right.start_frame || a - b;
  });
  for (let index = 1; index < order.length; index += 1) {
    const first = order[index - 1];
    const second = order[index];
    if (first === undefined || second === undefined) continue;
    const a = captions[first];
    const b = captions[second];
    if (b && a?.position === b.position && b.start_frame < a.end_frame) return [first, second];
  }
  return null;
}

function withFrame(caption: TimelineCaption, key: "start_frame" | "end_frame", value: number): TimelineCaption {
  const generated = caption.transcription;
  // Still the generated time: the record moves with it, so the caption is not taken for a manual edit later
  if (generated?.[key] === caption[key]) return { ...caption, transcription: { ...generated, [key]: value }, [key]: value };
  return { ...caption, [key]: value };
}

/** The captions without overlaps at the same position; the same array when nothing overlaps. */
export function fitCaptions(captions: readonly TimelineCaption[]): readonly TimelineCaption[] {
  let fitted = captions;
  for (let round = 0; round <= captions.length * captions.length; round += 1) {
    const pair = overlap(fitted);
    if (!pair) return fitted;
    const [firstIndex, secondIndex] = pair;
    const first = fitted[firstIndex];
    const second = fitted[secondIndex];
    if (!first || !second) return fitted;
    const next = [...fitted];
    if (first.start_frame < second.start_frame) {
      next[firstIndex] = withFrame(first, "end_frame", second.start_frame);
    } else {
      const length = Math.max(1, second.end_frame - second.start_frame);
      const moved = withFrame(second, "start_frame", first.end_frame);
      next[secondIndex] = withFrame(moved, "end_frame", Math.min(MAX_SEQUENCE_FRAMES, Math.max(second.end_frame, moved.start_frame + length)));
    }
    fitted = next;
  }
  return fitted;
}
