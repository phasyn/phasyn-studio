// The sound a render or an export makes when it ends: a short rising chime
// when it succeeded, two low falling notes when it failed or was interrupted, nothing when it was cancelled (whoever
// cancelled it knows). Synthesized with Web Audio, so there is no file to load. On by default and remembered per
// browser (renderSoundSetting). Browsers start audio only after the person has used the page: unlockRenderSound
// runs on the first pointer or key press and prepares the context, so a render that ends while the tab is in the
// background is still heard. Without Web Audio, or before any use of the page, nothing plays and nothing breaks.
import { createPersistentStore } from "@/lib/persistentStore";

export type RenderSound = "done" | "problem";

/** Whether a finished render or export plays its sound (per browser; on unless turned off). */
export const renderSoundSetting = createPersistentStore<boolean>({
  key: "phasyn.studio.render-sound",
  initial: true,
  parse: (raw) => raw !== false,
});

interface Note {
  /** Seconds after the start of the sound. */
  at: number;
  hz: number;
  /** Seconds the note rings out. */
  length: number;
  wave: OscillatorType;
  gain: number;
}

const SOUNDS: Readonly<Record<RenderSound, readonly Note[]>> = {
  // C6, E6, G6: a bright major arpeggio
  done: [
    { at: 0, hz: 1046.5, length: 0.55, wave: "sine", gain: 0.16 },
    { at: 0.09, hz: 1318.5, length: 0.55, wave: "sine", gain: 0.14 },
    { at: 0.18, hz: 1568, length: 0.8, wave: "sine", gain: 0.13 },
  ],
  // G4 then D4: low and soft, unmistakably not the success chime
  problem: [
    { at: 0, hz: 392, length: 0.32, wave: "triangle", gain: 0.2 },
    { at: 0.2, hz: 293.7, length: 0.55, wave: "triangle", gain: 0.2 },
  ],
};

let context: AudioContext | null = null;

function audio(): AudioContext | null {
  if (context) return context;
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return null;
  try {
    context = new window.AudioContext();
  } catch {
    return null;
  }
  return context;
}

/** Prepares the audio context from a user gesture (the browser lets it start only after one). */
export function unlockRenderSound(): void {
  const ctx = audio();
  if (ctx?.state === "suspended") void ctx.resume().catch(() => undefined);
}

function play(ctx: AudioContext, notes: readonly Note[]): void {
  const start = ctx.currentTime + 0.02;
  for (const note of notes) {
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = note.wave;
    oscillator.frequency.value = note.hz;
    const begin = start + note.at;
    // A soft attack and an exponential ring-out: no click at either end
    gain.gain.setValueAtTime(0.0001, begin);
    gain.gain.exponentialRampToValueAtTime(note.gain, begin + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, begin + note.length);
    oscillator.connect(gain).connect(ctx.destination);
    oscillator.start(begin);
    oscillator.stop(begin + note.length + 0.05);
  }
}

/** Plays a sound now; `force` plays it even when the setting is off (the preview next to the switch). */
export function playRenderSound(sound: RenderSound, force = false): void {
  if (!force && !renderSoundSetting.get()) return;
  const ctx = audio();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    // Allowed once the page has been used; otherwise the promise stays pending or rejects and nothing is heard
    void ctx.resume().then(() => { play(ctx, SOUNDS[sound]); }, () => undefined);
    return;
  }
  play(ctx, SOUNDS[sound]);
}
