import { useState } from "react";
import { Textarea } from "@/components/ui/controls";

/** 一行一項的字串清單；打字時保留空行與游標，空行不會存入清單。 */
export function StringListEditor({
  id,
  label,
  value,
  onChange,
  rows = 3,
  disabled,
  placeholder,
  help,
}: {
  id: string;
  label: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  rows?: number;
  disabled?: boolean;
  placeholder?: string;
  help?: string;
}) {
  const external = value.join("\n");
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const text = draft && draft.base === external ? draft.text : external;
  const helpId = help ? `${id}-help` : undefined;
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={id} className="text-data font-medium text-fg-secondary">
        {label}
      </label>
      <Textarea
        id={id}
        rows={rows}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        aria-describedby={helpId}
        className="min-h-20"
        onChange={(event) => {
          const next = event.target.value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          setDraft({ base: next.join("\n"), text: event.target.value });
          onChange(next);
        }}
      />
      {help ? (
        <p id={helpId} className="text-caption text-fg-tertiary">
          {help}
        </p>
      ) : null}
    </div>
  );
}
