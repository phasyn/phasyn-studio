import { lazy } from "react";

// Route modules loaded on demand: each page, and each area layout (with its explorer tree, panes and editors), gets
// its own chunk. While one loads, AppShell's Suspense shows the brand loading state inside the shell.
export const AdminLayout = lazy(() => import("./layout/AdminLayout").then((m) => ({ default: m.AdminLayout })));
export const InferenceLayout = lazy(() => import("./layout/inference/InferenceLayout").then((m) => ({ default: m.InferenceLayout })));
export const RecordsLayout = lazy(() => import("./layout/records/RecordsLayout").then((m) => ({ default: m.RecordsLayout })));

export const StudioPage = lazy(() => import("@/features/studio/StudioPage").then((m) => ({ default: m.StudioPage })));
export const ImageStudioPage = lazy(() => import("@/features/image-studio/ImageStudioPage").then((m) => ({ default: m.ImageStudioPage })));
export const ComponentsPage = lazy(() => import("@/features/components/ComponentsPage").then((m) => ({ default: m.ComponentsPage })));
export const PipelinesPage = lazy(() => import("@/features/pipelines/PipelinesPage").then((m) => ({ default: m.PipelinesPage })));
export const RunsPage = lazy(() => import("@/features/runs/RunsPage").then((m) => ({ default: m.RunsPage })));
export const RunDetailPage = lazy(() => import("@/features/runs/RunDetailPage").then((m) => ({ default: m.RunDetailPage })));
export const TrackingPage = lazy(() => import("@/features/tracking/TrackingPage").then((m) => ({ default: m.TrackingPage })));
export const SemanticsPage = lazy(() => import("@/features/semantics/SemanticsPage").then((m) => ({ default: m.SemanticsPage })));
export const RecordingsPage = lazy(() => import("@/features/recordings/RecordingsPage").then((m) => ({ default: m.RecordingsPage })));
export const ComparisonsPage = lazy(() => import("@/features/recordings/comparisons/ComparisonsPage").then((m) => ({ default: m.ComparisonsPage })));
export const InferencePage = lazy(() => import("@/features/inference/InferencePage").then((m) => ({ default: m.InferencePage })));
export const PromptStudiesPage = lazy(() => import("@/features/prompt-studies/PromptStudiesPage").then((m) => ({ default: m.PromptStudiesPage })));
