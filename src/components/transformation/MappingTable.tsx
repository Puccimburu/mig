import { ArrowDownToLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { mappingToCsv } from "@/lib/transform/csv";
import type { MappingEntry, MappingSource } from "@/lib/transform/types";
import { downloadBlob } from "./parts";

const SOURCE_LABEL: Record<MappingSource, string> = {
  file: "Mapping file",
  exact: "Exact match",
  alias: "Similar name",
  manual: "Manual",
  none: "Not mapped",
};

const SOURCE_TONE: Record<MappingSource, string> = {
  file: "info",
  exact: "success",
  alias: "warning",
  manual: "info",
  none: "neutral",
};

export function MappingTable({
  mapping,
  clientHeaders,
  clientSheet,
  samples,
  onChange,
}: {
  mapping: MappingEntry[];
  clientHeaders: string[];
  /** Name of the client's main data sheet, for the column heading. */
  clientSheet: string;
  samples: Record<string, string>;
  onChange: (mapping: MappingEntry[]) => void;
}) {
  function update(template: string, client: string) {
    onChange(
      mapping.map((m) =>
        m.template === template
          ? { ...m, client: client || null, source: client ? "manual" : "none" }
          : m,
      ),
    );
  }

  function setFuzzy(template: string, fuzzy: boolean) {
    onChange(mapping.map((m) => (m.template === template ? { ...m, fuzzy } : m)));
  }

  return (
    <>
      <div className="table-overflow">
        <table className="document-table transform-table">
          <thead>
            <tr>
              <th>Bulk import template column</th>
              <th>{clientSheet} column</th>
              <th>Match</th>
              <th title="Replace values that aren't an exact dropdown option with the closest option">
                Fuzzy match
              </th>
              <th>Sample value</th>
            </tr>
          </thead>
          <tbody>
            {mapping.map((m) => (
              <tr
                key={m.template}
                className={m.mandatory && !m.client ? "transform-row-missing" : ""}
              >
                <td>
                  <strong className="transform-col-name">{m.template}</strong>
                  <span className="transform-tags">
                    {m.mandatory && <span className="badge tone-danger">Mandatory</span>}
                    {m.dropdown && <span className="badge tone-info">Dropdown</span>}
                  </span>
                </td>
                <td>
                  {m.reserved ? (
                    <span className="text-muted-foreground">Kept from template</span>
                  ) : (
                    <select
                      aria-label={`Client column for ${m.template}`}
                      value={m.client ?? ""}
                      onChange={(e) => update(m.template, e.target.value)}
                    >
                      <option value="">— Not mapped —</option>
                      {clientHeaders.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td>
                  {!m.reserved && (
                    <span className={`badge tone-${SOURCE_TONE[m.source]}`}>
                      <i />
                      {SOURCE_LABEL[m.source]}
                    </span>
                  )}
                </td>
                <td>
                  {m.dropdown && !m.reserved ? (
                    <label className="transform-switch">
                      <Switch
                        checked={m.fuzzy}
                        onCheckedChange={(checked) => setFuzzy(m.template, checked)}
                        aria-label={`Fuzzy match ${m.template}`}
                      />
                      <span>{m.fuzzy ? "On" : "Exact only"}</span>
                    </label>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="transform-sample">{m.client ? (samples[m.client] ?? "—") : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="transform-actions transform-actions-start">
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            downloadBlob(
              new Blob([mappingToCsv(mapping)], { type: "text/csv" }),
              "column-mapping.csv",
            )
          }
        >
          <ArrowDownToLine />
          Export mapping CSV
        </Button>
      </div>
    </>
  );
}
