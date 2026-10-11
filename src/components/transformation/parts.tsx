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
