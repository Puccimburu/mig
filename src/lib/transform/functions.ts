import { createServerFn } from "@tanstack/react-start";

import type {
  ClientColumns,
  SupportingDocsOptions,
  TemplateSelection,
} from "@/lib/transform/types";

type FormOptions = {
  prefix?: string;
  templates?: TemplateSelection[];
  metadataSheet?: string;
  filesSheet?: string;
  columns?: ClientColumns;
  supportingDocs?: SupportingDocsOptions;
};

function requireFormData(data: unknown): FormData {
  if (!(data instanceof FormData)) throw new Error("Expected multipart form data.");
  return data;
}

// Form fields: "client" (one file), "template" (one or more files, in upload order),
// optional "mappingFile", and "options" (JSON).
async function readForm(form: FormData) {
  const { TransformError } = await import("@/server/transform/pipeline");
  const toInput = async (value: FormDataEntryValue) =>
    typeof value === "string"
      ? undefined
      : { name: value.name, data: new Uint8Array(await value.arrayBuffer()) };
  const one = async (key: string) => {
    const value = form.get(key);
    return value ? toInput(value) : undefined;
  };
  const client = await one("client");
  const templates = (await Promise.all(form.getAll("template").map(toInput))).filter(
    (t) => t !== undefined,
  );
  if (!client || !templates.length)
    throw new TransformError("Upload the client workbook and at least one template.");
  const options = JSON.parse(String(form.get("options") ?? "{}")) as FormOptions;
  return {
    files: { client, templates, mappingFile: await one("mappingFile") },
    options: {
      prefix: options.prefix ?? "",
      templates: options.templates,
      metadataSheet: options.metadataSheet,
      filesSheet: options.filesSheet,
      columns: options.columns,
      supportingDocs: options.supportingDocs,
    },
  };
}

export const inspectClientWorkbook = createServerFn({ method: "POST" })
  .validator(requireFormData)
  .handler(async ({ data }) => {
    const { inspectClient, TransformError } = await import("@/server/transform/pipeline");
    const value = data.get("client");
    if (!value || typeof value === "string")
      throw new TransformError("Upload the client workbook.");
    return inspectClient({ name: value.name, data: new Uint8Array(await value.arrayBuffer()) });
  });

// Form fields: "template" (one or more), optional "mappingFile", and "options" JSON with
// the chosen client sheet's headers. The client workbook itself isn't needed.
export const inspectTemplateColumns = createServerFn({ method: "POST" })
  .validator(requireFormData)
  .handler(async ({ data }) => {
    const { inspectTemplates, TransformError } = await import("@/server/transform/pipeline");
    const toInput = async (value: FormDataEntryValue) =>
      typeof value === "string"
        ? undefined
        : { name: value.name, data: new Uint8Array(await value.arrayBuffer()) };
    const templates = (await Promise.all(data.getAll("template").map(toInput))).filter(
      (t) => t !== undefined,
    );
    if (!templates.length) throw new TransformError("Upload at least one template.");
    const mappingValue = data.get("mappingFile");
    const mappingFile = mappingValue ? await toInput(mappingValue) : undefined;
    const { clientHeaders = [] } = JSON.parse(String(data.get("options") ?? "{}")) as {
      clientHeaders?: string[];
    };
    return inspectTemplates({ templates, mappingFile }, clientHeaders);
  });

export const analyzeTransformation = createServerFn({ method: "POST" })
  .validator(requireFormData)
  .handler(async ({ data }) => {
    const { analyze } = await import("@/server/transform/pipeline");
    const { files, options } = await readForm(data);
    return analyze(files, options);
  });

export const runTransformation = createServerFn({ method: "POST" })
  .validator(requireFormData)
  .handler(async ({ data }) => {
    const { run } = await import("@/server/transform/pipeline");
    const { files, options } = await readForm(data);
    return run(files, options);
  });
