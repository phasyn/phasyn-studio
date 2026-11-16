import { isDeepStrictEqual } from "node:util";
import { kernelArtifactManifest, readKernelManifest } from "./kernel-artifacts.mjs";

if (!isDeepStrictEqual(readKernelManifest(), kernelArtifactManifest())) {
  throw new Error("Editor kernel sources or generated outputs changed; run gen:kernel with the pinned local tools");
}
