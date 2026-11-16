// The audio graph of the Program monitor: one AudioContext for the editing surface. Every media element that sounds
// gets a chain (its gain, then one gain per channel for the stereo balance) and every chain ends in one master stage.
// The master stage is unity gain, so what is heard is exactly the sum of the chains, as before; a left and a right
// analyser hang off it and give the audio meters their levels. Channel balance matches the export and nothing is
// normalized or limited on the way out.

/** How loud a media element plays: its linear gain and the linear gain of each channel. */
export interface ChannelGains {
  gain: number;
  left: number;
  right: number;
}

/** Peak level of each output channel in dBFS; -Infinity while a channel is silent. */
export interface StereoLevels {
  left: number;
  right: number;
}

interface Chain {
  source: MediaElementAudioSourceNode;
  input: GainNode;
  splitter: ChannelSplitterNode;
  left: GainNode;
  right: GainNode;
  merger: ChannelMergerNode;
  connected: boolean;
}

interface MasterStage {
  /** Every chain connects here; it feeds the output and the analysers at unity gain. */
  input: GainNode;
  left: AnalyserNode;
  right: AnalyserNode;
  /** Scratch samples of one analyser read. */
  samples: Float32Array<ArrayBuffer>;
}

/** Samples an analyser hands out per read: about 43 ms at 48 kHz, more than the time between two animation frames. */
const METER_WINDOW = 2048;
const SILENT: StereoLevels = { left: -Infinity, right: -Infinity };

function createMaster(context: AudioContext): MasterStage {
  const input = context.createGain();
  input.channelCount = 2;
  input.channelCountMode = "explicit";
  const splitter = context.createChannelSplitter(2);
  const left = context.createAnalyser();
  const right = context.createAnalyser();
  left.fftSize = METER_WINDOW;
  right.fftSize = METER_WINDOW;
  input.connect(context.destination);
  // The analysers only listen: their outputs stay unconnected
  input.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);
  return { input, left, right, samples: new Float32Array(METER_WINDOW) };
}

function createChain(context: AudioContext, element: HTMLMediaElement): Chain {
  const input = context.createGain();
  input.channelCount = 2;
  input.channelCountMode = "explicit";
  return {
    source: context.createMediaElementSource(element),
    input,
    splitter: context.createChannelSplitter(2),
    left: context.createGain(),
    right: context.createGain(),
    merger: context.createChannelMerger(2),
    connected: false,
  };
}

function wire(chain: Chain, master: MasterStage): void {
  chain.source.connect(chain.input).connect(chain.splitter);
  chain.splitter.connect(chain.left, 0);
  chain.splitter.connect(chain.right, 1);
  chain.left.connect(chain.merger, 0, 0);
  chain.right.connect(chain.merger, 0, 1);
  chain.merger.connect(master.input);
  chain.connected = true;
}

/** The loudest sample the analyser currently holds, in dBFS. */
function peakLevel(analyser: AnalyserNode, samples: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(samples);
  let peak = 0;
  for (const sample of samples) {
    const size = Math.abs(sample);
    if (size > peak) peak = size;
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

export function createMonitorAudio() {
  let context: AudioContext | null = null;
  let master: MasterStage | null = null;
  const wanted = new Map<HTMLMediaElement, ChannelGains>();
  const chains = new WeakMap<HTMLMediaElement, Chain>();

  const connect = (element: HTMLMediaElement) => {
    if (!context || !master) return;
    let chain = chains.get(element);
    if (!chain) {
      chain = createChain(context, element);
      chains.set(element, chain);
    }
    if (!chain.connected) wire(chain, master);
  };

  const update = (element: HTMLMediaElement, value: ChannelGains) => {
    wanted.set(element, value);
    connect(element);
    const chain = chains.get(element);
    if (chain && context) {
      element.volume = 1;
      chain.left.gain.setValueAtTime(value.gain * value.left, context.currentTime);
      chain.right.gain.setValueAtTime(value.gain * value.right, context.currentTime);
    } else element.volume = 0;
  };

  return {
    async start() {
      context ??= new AudioContext();
      master ??= createMaster(context);
      for (const [element, value] of wanted) update(element, value);
      await context.resume();
    },
    update,
    release(element: HTMLMediaElement) {
      const chain = chains.get(element);
      if (chain) {
        const now = context?.currentTime ?? 0;
        chain.left.gain.setValueAtTime(0, now);
        chain.right.gain.setValueAtTime(0, now);
        for (const node of [chain.source, chain.input, chain.splitter, chain.left, chain.right, chain.merger]) node.disconnect();
        chain.connected = false;
      }
      wanted.delete(element);
    },
    /** The peak level of the output right now, per channel in dBFS; silent before the first start and while the context is not running. */
    levels(): StereoLevels {
      if (!context || !master || context.state !== "running") return SILENT;
      return { left: peakLevel(master.left, master.samples), right: peakLevel(master.right, master.samples) };
    },
    async close() {
      wanted.clear();
      const owned = context;
      context = null;
      master = null;
      if (owned && owned.state !== "closed") await owned.close();
    },
  };
}

export type MonitorAudio = ReturnType<typeof createMonitorAudio>;
