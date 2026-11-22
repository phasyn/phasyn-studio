import type { ComponentPropsWithRef } from "react";
import type { CaptionTrack } from "./linkedCaptions";

interface CaptionsProp {
  captions?: CaptionTrack | undefined;
}

export function AssetVideo({ captions, ...props }: ComponentPropsWithRef<"video"> & CaptionsProp) {
  if (captions) return <video {...props}><track kind="captions" {...captions} /></video>;
  // eslint-disable-next-line jsx-a11y-x/media-has-caption -- Generated takes and imported footage can arrive without a caption file.
  return <video {...props} />;
}

export function AssetAudio({ captions, ...props }: ComponentPropsWithRef<"audio"> & CaptionsProp) {
  if (captions) return <audio {...props}><track kind="captions" {...captions} /></audio>;
  // eslint-disable-next-line jsx-a11y-x/media-has-caption -- An audio asset can contain only music, or have no supplied caption file.
  return <audio {...props} />;
}
