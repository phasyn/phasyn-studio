// New-project form shared by both Studios (one project list for both): the title plus the Studio's own fields. The
// project is saved once (revision 0) and written to the query cache before the caller navigates to it.
import { useQueryClient } from "@tanstack/react-query";
import { FolderPlus } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { StudioProject } from "@/api/generated/contracts";
import { saveProject, studioKeys } from "@/api/studioProjects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/controls";
import { errorText } from "@/lib/errors";
import { t } from "@/i18n";

/**
 * Whether the title field takes focus when the form appears:
 * - "always": the user asked for a new project (the command palette's "new project");
 * - "unless-focused": the form appears by itself, for example once the project list has loaded, and must not take
 *   the focus the user has already placed elsewhere in the meantime.
 */
export type NewProjectFocus = "always" | "unless-focused";

export interface NewProjectFormProps {
  /** Builds the new document from the trimmed title (empty = untitled). */
  build: (title: string) => StudioProject;
  onCreated: (projectId: string) => void;
  placeholder: string;
  /** Focus the title field once, when the form first appears (default: never). */
  initialFocus?: NewProjectFocus;
  /** The Studio's extra fields (for example the video format). */
  children?: ReactNode;
}

export function NewProjectForm({ build, onCreated, placeholder, initialFocus, children }: NewProjectFormProps) {
  const client = useQueryClient();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const helpId = useId();

  useEffect(() => {
    if (!initialFocus) return;
    const active = document.activeElement;
    if (initialFocus === "always" || !active || active === document.body) titleRef.current?.focus();
  }, [initialFocus]);

  const create = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const saved = await saveProject(build(title.trim() || t("未命名專案")));
      client.setQueryData(studioKeys.project(saved.project_id), saved);
      await client.invalidateQueries({ queryKey: studioKeys.projects() });
      onCreated(saved.project_id);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void create();
      }}
    >
      <div className="grid gap-1">
        <label className="grid gap-1 text-caption font-medium text-fg-secondary">
          {t("專案名稱")}
          <Input
            ref={titleRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              // Enter submits the form: with no title it would create an untitled project from a key press that may
              // have been meant for something else. An untitled project takes the button.
              if (event.key === "Enter" && !event.nativeEvent.isComposing && title.trim() === "") event.preventDefault();
            }}
            maxLength={200}
            placeholder={placeholder}
            aria-describedby={helpId}
            className="min-h-9 py-1.5 text-data"
          />
        </label>
        <p id={helpId} className="text-caption text-fg-tertiary">
          {t("留空時按「建立專案」會建立「未命名專案」；名稱空白時按 Enter 不會建立。")}
        </p>
      </div>
      {children}
      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" icon={<FolderPlus aria-hidden />} pending={pending}>
        {t("建立專案")}
      </Button>
    </form>
  );
}
