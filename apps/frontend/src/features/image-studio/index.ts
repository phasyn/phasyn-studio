// Public entry of Image Studio: what other features (prompt studies) reuse. The page itself is lazy-loaded by the app
// router, so it is not re-exported. Named exports only; add an item here instead of importing a file inside the feature.
export { deriveImageRoutes, shotRouteProblem } from "./model/routes";
