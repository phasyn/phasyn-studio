import { Navigate, useLocation } from "react-router";
import { PATHS } from "./paths";

/** /studio opens the Shots workspace, where a film starts, and keeps ?project= (and the hash). */
export function StudioIndex() {
  const location = useLocation();
  return <Navigate to={`${PATHS.studioGenerate}${location.search}${location.hash}`} replace />;
}
