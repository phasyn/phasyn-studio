// Port declarations of the built-in providers, as the Node reports them in GET /api/catalog
// (name, type, required, transport). Tests that only need "a component of provider X" get
// realistic ports for free; pass `inputs` / `outputs` to `descriptor()` to override.
import type { Port } from "@/api/generated/contracts";

/** One port; descriptions are irrelevant to tests, so they default to the port name. */
export function port(name: string, type_id: string, required = true, transport: Port["transport"] = "inline", description = name): Port {
  return { name, type_id, required, transport, description };
}

const file = (name: string, type_id: string, required = true) => port(name, type_id, required, "file");

export interface ProviderPorts {
  readonly inputs: readonly Port[];
  readonly outputs: readonly Port[];
}

export const PROVIDER_PORTS: Readonly<Record<string, ProviderPorts>> = {
  "h3.conditioning": {
    inputs: [
      port("prompt", "text.prompt.v1"),
      file("first_frame", "media.image.v1", false),
      file("last_frame", "media.image.v1", false),
      port("materials", "h3.materials.v1", false),
      file("prepared", "h3.prepared-media.v1", false),
      port("job", "h3.job.v1", false),
    ],
    outputs: [file("conditioning", "h3.conditioning.tap50.v1", false), file("prepared", "h3.prepared-media.v1", false), port("job", "h3.job.v1")],
  },
  "h3.reference": {
    inputs: [file("prepared", "h3.prepared-media.v1"), port("job", "h3.job.v1")],
    outputs: [file("references", "h3.references.v1")],
  },
  // Split reference encoders (ref2va): each writes one partial bundle that h3.dit takes as `video_references` /
  // `audio_references` (never together with the merged `references`).
  "h3.video_encode": {
    inputs: [file("prepared", "h3.prepared-media.v1"), port("job", "h3.job.v1")],
    outputs: [file("video_references", "h3.references.video.v1")],
  },
  "h3.audio_encode": {
    inputs: [file("prepared", "h3.prepared-media.v1"), port("job", "h3.job.v1")],
    outputs: [file("audio_references", "h3.references.audio.v1")],
  },
  "h3.dit": {
    inputs: [
      file("conditioning", "h3.conditioning.tap50.v1"),
      port("job", "h3.job.v1"),
      file("prepared", "h3.prepared-media.v1", false),
      file("references", "h3.references.v1", false),
    ],
    outputs: [file("video_latent", "video.final-latent.v1"), file("audio_latent", "audio.final-latent.v1")],
  },
  "h3.video_decode": { inputs: [file("latent", "video.final-latent.v1")], outputs: [port("asset", "media.asset.v1")] },
  "h3.audio_decode": { inputs: [file("latent", "audio.final-latent.v1")], outputs: [file("audio", "media.audio.v1")] },
  "media.mux": { inputs: [port("video", "media.asset.v1"), file("audio", "media.audio.v1")], outputs: [port("asset", "media.asset.v1")] },
  "media.frame": { inputs: [port("video", "media.asset.v1", false), file("video_file", "media.video.v1", false)], outputs: [file("image", "media.image.v1")] },
  "media.concat": { inputs: [port("sequence", "media.sequence.v1")], outputs: [port("asset", "media.asset.v1")] },
  "qwen_vl.describe": { inputs: [file("video", "media.video.v1")], outputs: [file("scene", "video.scene.v1")] },
  "qimg.prepare": { inputs: [port("references", "qimg.references.v1"), file("mask", "media.image.v1", false)], outputs: [file("prepared", "qimg.prepared.v1")] },
  "qimg.conditioning": {
    inputs: [port("prompt", "text.prompt.v1"), port("negative_prompt", "text.prompt.v1", false), file("prepared", "qimg.prepared.v1", false)],
    outputs: [file("conditioning", "qimg.conditioning.v1")],
  },
  "qimg.vae_encode": { inputs: [file("prepared", "qimg.prepared.v1")], outputs: [file("ref_latents", "qimg.ref_latents.v1")] },
  "qimg.dit": { inputs: [file("conditioning", "qimg.conditioning.v1"), file("ref_latents", "qimg.ref_latents.v1", false)], outputs: [file("latent", "qimg.latent.v1")] },
  "qimg.vae_decode": { inputs: [file("latent", "qimg.latent.v1")], outputs: [port("image", "image.asset.v1")] },
  "image.compose": {
    inputs: [port("image", "image.asset.v1"), file("prepared", "qimg.prepared.v1", false)],
    outputs: [port("image", "image.asset.v1"), port("image_white", "image.asset.v1")],
  },
  "test.echo": { inputs: [port("value", "test.echo.v1", true, "either")], outputs: [port("value", "test.echo.v1", true, "either")] },
  "test.synthetic_latent": { inputs: [port("prompt", "text.prompt.v1", false)], outputs: [file("video_latent", "video.final-latent.v1")] },
  "test.synthetic_decode": { inputs: [file("latent", "video.final-latent.v1")], outputs: [port("asset", "media.asset.v1")] },
};

/** Fresh copies of a provider's ports (unknown provider → no ports). */
export function providerPorts(provider_id: string): { inputs: Port[]; outputs: Port[] } {
  const ports = PROVIDER_PORTS[provider_id];
  return { inputs: ports?.inputs.map((item) => ({ ...item })) ?? [], outputs: ports?.outputs.map((item) => ({ ...item })) ?? [] };
}
