import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "@/app/layout/AppShell";
import {
  AdminLayout,
  ComparisonsPage,
  ComponentsPage,
  ImageStudioPage,
  InferenceLayout,
  InferencePage,
  PipelinesPage,
  PromptStudiesPage,
  RecordingsPage,
  RecordsLayout,
  RunDetailPage,
  RunsPage,
  SemanticsPage,
  StoragePage,
  StudioPage,
  TrackingPage,
  TrainingPage,
} from "./lazyPages";
import { NotFoundPage } from "./NotFoundPage";
import { PATHS } from "./paths";
import { RouteErrorPage } from "./RouteErrorPage";
import { StudioIndex } from "./StudioIndex";

/** Pages that render their own workbench frame (WorkbenchPage); other pages sit in the area layout's single panel. */
const SELF = { frame: "self" } as const;

/**
 * Data router (unsaved drafts can confirm leaving with useBlocker). Five areas:
 *   Image Studio  /image?project=&shot=&take= (shares projects and the media library with Video Studio)
 *   Video Studio  /studio/generate?project=&shot=, /studio/edit?project=&shot=&layout=, /studio/render?project=&run=
 *                 (the removed /studio/effects opens /studio/edit and keeps its query)
 *   Inference     /inference → /inference/semantics?describe_run=&caption_run=&export_run= (home),
 *                 /inference/prompt-studies?study=&tab=, /inference/run?pipeline=&run= (manual run)
 *   Components    /admin/components?node=&component=, /admin/pipelines, /admin/pipelines/new, /admin/pipelines/:pipelineId
 *   Records       /records/runs, /records/runs/:runId, /records/recordings, /records/recordings/:recordingId (?component_id=&node_id=&run_id=),
 *                 /records/comparisons?ids=a,b, /records/tracking, /records/storage
 * Paths come from paths.ts; anything else is a 404.
 */
export function createAppRouter() {
  return createBrowserRouter([
    {
      path: "/",
      element: <AppShell />,
      errorElement: <RouteErrorPage />,
      children: [
        {
          // An error inside a page renders here, inside the shell: the navigation stays usable
          errorElement: <RouteErrorPage inline />,
          children: [
        { index: true, element: <Navigate to={PATHS.studio} replace /> },
        { path: "image", element: <ImageStudioPage /> },
        { path: "studio", element: <StudioIndex /> },
        { path: "studio/:workspace", element: <StudioPage /> },
        {
          path: "inference",
          element: <InferenceLayout />,
          children: [
            { index: true, element: <Navigate to={PATHS.semantics} replace /> },
            { path: "semantics", element: <SemanticsPage />, handle: SELF },
            { path: "prompt-studies", element: <PromptStudiesPage />, handle: SELF },
            { path: "run", element: <InferencePage />, handle: SELF },
            { path: "training", element: <TrainingPage />, handle: SELF },
            { path: "*", element: <NotFoundPage /> },
          ],
        },
        {
          path: "admin",
          element: <AdminLayout />,
          children: [
            { index: true, element: <Navigate to={PATHS.components} replace /> },
            { path: "components", element: <ComponentsPage />, handle: SELF },
            { path: "pipelines", element: <PipelinesPage />, handle: SELF },
            { path: "pipelines/new", element: <PipelinesPage />, handle: SELF },
            { path: "pipelines/:pipelineId", element: <PipelinesPage />, handle: SELF },
            { path: "*", element: <NotFoundPage /> },
          ],
        },
        {
          path: "records",
          element: <RecordsLayout />,
          children: [
            { index: true, element: <Navigate to={PATHS.runs} replace /> },
            { path: "runs", element: <RunsPage />, handle: SELF },
            { path: "runs/:runId", element: <RunDetailPage />, handle: SELF },
            { path: "recordings", element: <RecordingsPage />, handle: SELF },
            { path: "recordings/:recordingId", element: <RecordingsPage />, handle: SELF },
            { path: "comparisons", element: <ComparisonsPage />, handle: SELF },
            { path: "tracking", element: <TrackingPage />, handle: SELF },
            { path: "storage", element: <StoragePage /> },
            { path: "*", element: <NotFoundPage /> },
          ],
        },
        { path: "*", element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ]);
}
