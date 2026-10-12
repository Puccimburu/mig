import { useRef, type ReactNode } from "react";
import { FileSpreadsheet, Files, X } from "lucide-react";

import { Button } from "@/components/ui/button";
const TONE_CLASS = {
  neutral: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
} as const;

export function Metric({
  label,
  value,
  note,
  tone = "neutral",
}: {
  label: string;
  value: number;
  note: string;
  tone?: keyof typeof TONE_CLASS;
}) {
  return (
    <div className="transform-metric">
      <span>{label}</span>
      <strong className={TONE_CLASS[tone]}>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = window.document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

export function FileSlot({
  title,
  hint,
  accept,
  multiple = false,
  files,
  onAdd,
  onRemove,
}: {
  title: string;
  hint: string;
  accept: string;
  multiple?: boolean;
  files: File[];
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={`upload-zone transform-slot ${files.length ? "filled" : ""}`}>
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        aria-label={title}
        onChange={(e) => {
          onAdd(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <div className="upload-icon">{multiple ? <Files /> : <FileSpreadsheet />}</div>
      <h3>
        {title}
        {multiple && files.length > 0 && <span className="count-pill">{files.length}</span>}
      </h3>
      {files.map((f, i) => (
        <p key={`${f.name}-${i}`} className="transform-file">
          <span>{f.name}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5"
            aria-label={`Remove ${f.name}`}
            onClick={() => onRemove(i)}
          >
            <X />
          </Button>
        </p>
      ))}
      {(multiple || !files.length) && (
        <p>
          <Button variant="link" className="browse" onClick={() => input.current?.click()}>
            {files.length ? "Add more" : multiple ? "Choose files" : "Choose file"}
          </Button>
        </p>
      )}
      <small>{hint}</small>
    </div>
  );
}

export function Step({
  number,
  title,
  aside,
  children,
}: {
  number: number;
  title: string;
  aside?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className="transform-step">
      <div className="section-heading">
        <h2>
          <span className="transform-step-number">{number}</span>
          {title}
        </h2>
        {aside && <span>{aside}</span>}
      </div>
      {children}
    </section>
  );
}
