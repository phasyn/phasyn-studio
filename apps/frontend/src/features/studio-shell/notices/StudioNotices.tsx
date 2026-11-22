// The notices of the current Studio page (from the shell context); "#engine" links open the engine sheet.
import { useStudioShell } from "../StudioShellContext";
import { Notices } from "./Notices";

export function StudioNotices() {
  const { notices, dismiss, setEngineOpen } = useStudioShell();
  return <Notices notices={notices} onDismiss={dismiss} onEngine={() => { setEngineOpen(true); }} />;
}
