// @vitest-environment node
// Integration tests against the real reference workbooks. They hold client data, so
// they are not part of the repo: point TRANSFORM_FIXTURES at the folder holding them.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { beforeAll, describe, expect, it } from "vitest";

import { runRaw, type PipelineFiles } from "@/server/transform/pipeline";
import { analyze, inspectClient, inspectTemplates } from "@/server/transform/pipeline";
import { DEFAULT_PREFIX } from "@/lib/transform/types";
import { readTable } from "@/server/transform/read";
import { Workbook } from "@/server/transform/workbook";

const DIR = process.env["TRANSFORM_FIXTURES"] ?? "C:/Users/Execo/Desktop/New folder";
const CLIENT = "Execo Analysis (Aug 05)_leah_import_071726_092753.xlsx";
const TEMPLATE = "NDA_Aug_20.xlsx";
const available = existsSync(path.join(DIR, CLIENT)) && existsSync(path.join(DIR, TEMPLATE));
const PREFIX = "https://contractpodai.sharepoint.com/sites/";

const load = (name: string) => ({ name, data: new Uint8Array(readFileSync(path.join(DIR, name))) });

/** Copy of the client workbook with the "File Paths" column and "File Path" tab removed (the INITIAL state). */
async function initialClient(data: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(data);
  const sheet = await zip.file("xl/worksheets/sheet3.xml")!.async("string");
  // Drop column D's header and values, keeping the column itself (simulates a sheet without the header).
  const stripped = sheet.replace(/<c r="D(\d+)"[^>]*?(?:\/>|>.*?<\/c>)/g, "");
  zip.file("xl/worksheets/sheet3.xml", stripped);
  return zip.generateAsync({ type: "uint8array" });
}

describe.skipIf(!available)("reference workbooks", () => {
  let files: PipelineFiles;
  beforeAll(() => {
    files = { client: load(CLIENT), templates: [load(TEMPLATE)] };
  });

  it("analyzes sheets, app type and mapping", async () => {
    const a = await analyze(files, { prefix: PREFIX });
    expect(a.client.metadataSheet).toBe("Metadata Extraction");
    expect(a.client.filesSheet).toBe("Files on SP");
    expect(a.templates[0]).toMatchObject({
      label: "NDA",
      appTypes: ["NDA Agreement"],
      templateRows: 67,
    });
    expect(a.filePaths.missingPrefix).toBe(0);
    expect(a.filePaths.metadataUnmatched).toBe(0);
    const mapping = a.templates[0]!.mapping;
    const map = Object.fromEntries(mapping.map((m) => [m.template, m.client]));
    expect(map["Party Name"]).toBe("Party Name (Counterparty Name)");
    expect(map["Assignee"]).toBe("Assignee (Only 1 Email ID)");
    expect(map["Application Type Custom Fields(TerminalLocation)"]).toBe("Terminal Location");
    expect(map["Application Type Custom Fields(Region)"]).toBe("Region");
    expect(map["Effective Date"]).toBe("Effective Date");
    expect(mapping.filter((m) => m.mandatory && !m.client)).toEqual([]);
  }, 60_000);

  it("fills the template in place and matches the hand-made file paths", async () => {
    const original = await Workbook.load(files.client.data);
    const result = await runRaw(files, { prefix: PREFIX });
    const out = await Workbook.load(result.clientBytes);

    // Generated File Path tab equals the hand-made one, row for row.
    const expected = readTable(original.sheet("File Path"));
    const actual = readTable(out.sheet("File Path"));
    expect(actual.dataRows.length).toBe(expected.dataRows.length);
    for (const r of expected.dataRows) {
      expect(actual.sheet.get(2, r)).toBe(expected.sheet.get(2, r));
    }
    // Existing "File Paths" column was reused, values unchanged.
    expect(result.summary.columnInserted).toBe(false);
    const meta = original.sheet("Metadata Extraction");
    const metaOut = out.sheet("Metadata Extraction");
    // Same first-match rule as the team's VLOOKUP, so the hand-made column is reproduced.
    const differing = readTable(meta).dataRows.filter((r) => metaOut.get(4, r) !== meta.get(4, r));
    expect(differing).toEqual([]);
    expect(result.summary.duplicateNames).toBeGreaterThan(1000);

    // Template: untouched parts byte-identical, validations and prefixes preserved.
    const before = await JSZip.loadAsync(files.templates[0]!.data);
    const after = await JSZip.loadAsync(result.templateBytes[0]!);
    const changed = ["xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml", "xl/styles.xml"];
    expect(Object.keys(after.files).sort()).toEqual(Object.keys(before.files).sort());
    for (const name of Object.keys(before.files)) {
      if (changed.includes(name)) continue;
      expect(await after.file(name)!.async("string"), name).toBe(
        await before.file(name)!.async("string"),
      );
    }
    for (const name of changed.slice(0, 2)) {
      const b = await before.file(name)!.async("string");
      const a = await after.file(name)!.async("string");
      expect(a.match(/<x:dataValidation /g)?.length).toBe(b.match(/<x:dataValidation /g)?.length);
      expect(a.startsWith("<?xml")).toBe(true);
      expect(a).not.toMatch(/<(c|row|v|is|t) /);
    }

    const tpl = await Workbook.load(result.templateBytes[0]!);
    const cr = tpl.sheet("Contract Request");
    expect(cr.get(1, 2)).toBe("883afff1-333c-4616-a404-568506f51cc1");
    expect(cr.get(2, 68)).toBe("67");
    expect(cr.get(3, 2)).toBe("Criterion Group LLC");
    expect(cr.get(20, 2)).toBe("2025-09-11"); // Effective Date
    const cv = tpl.sheet("Contract Version");
    expect(cv.get(1, 2)).toBe("1");
    expect(String(cv.get(2, 2))).toMatch(/^Enstructure\/Shared Documents\/.*Criterion NDA/);
    expect([cv.get(3, 68), cv.get(4, 68), cv.get(5, 68)]).toEqual([1, "Yes", "Yes"]);
    expect(cv.get(1, 69)).toBeNull();

    // Party Type "Other" is fuzzy-corrected to the option "Others".
    const partyType = result.flags.filter((f) => f.column === "Party Type");
    expect(partyType.length).toBe(45);
    expect(partyType.every((f) => f.kind === "fuzzy" && f.suggestion === "Others")).toBe(true);
    expect(cr.get(4, 2)).toBe("Others");
    // Party Name and Legal Party stay exact-only: mismatches are flagged, not changed.
    expect(
      result.flags.some((f) => f.kind === "fuzzy" && /Party Name|Legal Party/.test(f.column)),
    ).toBe(false);
    expect(out.sheetNames).toContain("Flags");
  }, 120_000);

  it("starts paths at Enstructure-Contracts-Upload with the default prefix", async () => {
    const result = await runRaw(files, { prefix: DEFAULT_PREFIX });
    const paths = readTable((await Workbook.load(result.clientBytes)).sheet("File Path"));
    const values = paths.dataRows.map((r) => String(paths.sheet.get(2, r)));
    expect(values).toHaveLength(4046);
    expect(
      values.filter((v) => !/^(Enstructure-Contracts-Upload|Testing-06\.06\.2026)\//.test(v)),
    ).toEqual([]);
    expect(result.flags.filter((f) => f.kind === "prefix")).toEqual([]);
  }, 120_000);

  it("flags instead of correcting when fuzzy matching is turned off", async () => {
    const a = await analyze(files, { prefix: PREFIX });
    const mapping = a.templates[0]!.mapping.map((m) => ({ ...m, fuzzy: false }));
    const result = await runRaw(files, {
      prefix: PREFIX,
      templates: [{ index: 0, appTypes: ["NDA Agreement"], mapping }],
    });
    expect(result.flags.filter((f) => f.kind === "fuzzy")).toEqual([]);
    const partyType = result.flags.filter((f) => f.column === "Party Type");
    expect(partyType.length).toBe(45);
    expect(partyType.every((f) => f.kind === "dropdown" && f.suggestion === "Others")).toBe(true);
    const cr = (await Workbook.load(result.templateBytes[0]!)).sheet("Contract Request");
    expect(cr.get(4, 2)).toBe("Other");
  }, 120_000);

  it("lists the client sheets and uses the one chosen as main data", async () => {
    const sheets = await inspectClient(files.client);
    expect(sheets.metadataSheet).toBe("Metadata Extraction");
    expect(sheets.filesSheet).toBe("Files on SP");
    expect(sheets.sheets.find((x) => x.name === "Metadata Extraction")).toMatchObject({
      rows: 1371,
      guess: { fileName: "File Name (with extension)", appType: "Application Type" },
    });
    expect(sheets.sheets.find((x) => x.name === "Files on SP")?.guess).toMatchObject({
      filesName: "Name",
      filesFolder: "Folder Path",
    });
    expect(sheets.sheets.map((x) => x.name)).toContain("Document mapping");

    const chosen = await analyze(files, {
      prefix: PREFIX,
      metadataSheet: "Metadata Extraction",
      filesSheet: "Files on SP",
    });
    expect(chosen.client.metadataSheet).toBe("Metadata Extraction");
    // The application type column is optional: without one, every row is one group.
    const noAppType = await analyze(files, { prefix: PREFIX, metadataSheet: "Document mapping" });
    expect(noAppType.client.appTypeColumn).toBeNull();
    expect(noAppType.client.appTypes.map((a) => a.name)).toEqual(["All rows"]);
    expect(noAppType.client.appTypes[0]!.count).toBe(noAppType.client.requestRows);
    expect(noAppType.templates[0]!.appTypes).toEqual(["All rows"]);
    await expect(analyze(files, { prefix: PREFIX, metadataSheet: "Nope" })).rejects.toThrow(
      /not in the client workbook/,
    );
  }, 120_000);

  it("proposes the mapping from template headers and the chosen sheet before analysis", async () => {
    const sheets = await inspectClient(files.client);
    const main = sheets.sheets.find((x) => x.name === "Metadata Extraction")!;
    expect(main.samples["Party Name (Counterparty Name)"]).toBe("Criterion Group LLC");
    const [cols] = await inspectTemplates({ templates: files.templates }, main.headers);
    expect(cols).toMatchObject({ label: "NDA", fileName: TEMPLATE });
    expect(cols!.requestHeaders[0]).toBe("Batch Id");
    const map = Object.fromEntries(cols!.mapping.map((m) => [m.template, m.client]));
    expect(map["Party Name"]).toBe("Party Name (Counterparty Name)");
    expect(map["Application Type Custom Fields(Region)"]).toBe("Region");
  }, 60_000);

  it("uses the key columns chosen in the UI when the headers differ", async () => {
    // Rename the file name header, as in client files that don't use the usual wording.
    const zip = await JSZip.loadAsync(files.client.data);
    const strings = await zip.file("xl/sharedStrings.xml")!.async("string");
    zip.file(
      "xl/sharedStrings.xml",
      strings.split(">File Name (with extension)<").join(">Document Name<"),
    );
    const client = { name: CLIENT, data: await zip.generateAsync({ type: "uint8array" }) };

    const sheets = await inspectClient(client);
    const main = sheets.sheets.find((x) => x.name === "Metadata Extraction")!;
    expect(main.headers).toContain("Document Name");
    expect(main.guess).toMatchObject({ fileName: null, appType: "Application Type" });
    await expect(analyze({ ...files, client }, { prefix: PREFIX })).rejects.toThrow(
      /Choose the file name column/,
    );

    const columns = {
      fileName: "Document Name",
      appType: "Application Type",
      filesName: "Name",
      filesFolder: "Folder Path",
    };
    const a = await analyze({ ...files, client }, { prefix: PREFIX, columns });
    expect(a.filePaths.metadataUnmatched).toBe(0);
    const result = await runRaw({ ...files, client }, { prefix: PREFIX, columns });
    expect(result.templates[0]).toMatchObject({ status: "filled", rowsWritten: 67 });
  }, 120_000);

  it("matches several templates to app types by file name and fills them in one run", async () => {
    const nda = load(TEMPLATE);
    const templates = [
      { name: "Rate_Sheet_Agreement_Aug_20.xlsx", data: nda.data },
      { name: "Not a template.xlsx", data: files.client.data },
      nda,
      { name: "Vendor Agreement - Template.xlsx", data: nda.data },
    ];
    const a = await analyze({ ...files, templates }, { prefix: PREFIX });
    expect(a.templates.map((t) => [t.label, t.appTypes])).toEqual([
      ["Rate Sheet Agreement", ["Rate Sheet"]],
      ["Not a", []],
      ["NDA", ["NDA Agreement"]],
      ["Vendor Agreement", ["Vendor Agreement"]],
    ]);
    // Only Parent-Main Agreement rows count (Rate Sheet: 230 of 258).
    expect(a.client.docTypeColumn).toBe("Doc Type");
    expect(a.client.appTypes.find((x) => x.name === "Rate Sheet")?.count).toBe(230);
    expect(a.templates[1]!.error).toMatch(/Contract Request/);
    expect(Object.keys(a.samples)).toContain("Rate Sheet");

    const result = await runRaw({ ...files, templates }, { prefix: PREFIX });
    expect(result.templates.map((t) => t.status)).toEqual([
      "skipped",
      "skipped",
      "filled",
      "skipped",
    ]);
    expect(result.templates[0]!.error).toMatch(
      /"Rate Sheet" has 230 rows .* 67 Record Reference Ids/,
    );
    expect(result.templates[2]).toMatchObject({ appTypes: ["NDA Agreement"], rowsWritten: 67 });
    const docs = result.summary.documents;
    expect(docs.total).toBe(1371);
    expect(docs.completed + docs.needsAttention + docs.pending).toBe(1371);
    expect(docs.completed).toBeGreaterThan(50); // 67 NDA rows, a few with Party Name issues
    expect(docs.completed).toBeLessThan(67);
    expect(result.templates[2]!.output!.fileName).toBe("NDA_Aug_20_filled.xlsx");
    expect(
      result.flags.filter((f) => f.workbook === "template").every((f) => f.template === TEMPLATE),
    ).toBe(true);
    const flagsTab = (await Workbook.load(result.clientBytes)).sheet("Flags");
    expect(flagsTab.get(2, 1)).toBe("Template");
  }, 120_000);

  it("inserts the File Path column when the client sheet has none", async () => {
    const client = { name: CLIENT, data: await initialClient(files.client.data) };
    const result = await runRaw({ ...files, client }, { prefix: PREFIX });
    expect(result.summary.columnInserted).toBe(true);
    const out = await Workbook.load(result.clientBytes);
    const meta = out.sheet("Metadata Extraction");
    expect(meta.get(2, 1)).toBe("File Name (with extension)");
    expect(meta.get(3, 1)).toBe("File Path");
    expect(String(meta.get(3, 2))).toMatch(
      /Criterion NDA 20250910\.1 \(Executed\) \[Fully Executed\]\.pdf$/,
    );
    expect(meta.get(4, 1)).toBe("Amendment Request ID"); // shifted from C
    const xml = await (
      await JSZip.loadAsync(result.clientBytes)
    )
      .file("xl/worksheets/sheet3.xml")!
      .async("string");
    expect(xml).toContain('sqref="J2:J1000"'); // Party Name validation moved from I
    expect(xml).toContain('ref="X2"'); // hyperlink moved from W
  }, 120_000);
});

// The HBG "IT Agreements" files: one template covering several client app types, and a
// sheet that mixes Parent-Main Agreement rows with amendments, renewals and supporting docs.
const HBG_DIR = process.env["TRANSFORM_FIXTURES_HBG"] ?? "C:/Users/Execo/Downloads";
const HBG_CLIENT =
  "Copy of Copy of Updated with ParentChild_Extraction Delivery 03_1263 Docs_September 14_IT Agreements_TL2A_JN (2).xlsx";
const HBG_TEMPLATE = "IT Agreements_Oct 05 (1).xlsx";
const hbgAvailable =
  existsSync(path.join(HBG_DIR, HBG_CLIENT)) && existsSync(path.join(HBG_DIR, HBG_TEMPLATE));

describe.skipIf(!hbgAvailable)("IT Agreements workbooks", () => {
  const hbg = (name: string) => ({
    name,
    data: new Uint8Array(readFileSync(path.join(HBG_DIR, name))),
  });

  it("fills the IT Agreements template from all IT app types' parent rows", async () => {
    const files = { client: hbg(HBG_CLIENT), templates: [hbg(HBG_TEMPLATE)] };
    const opts = {
      prefix: DEFAULT_PREFIX,
      metadataSheet: "Extraction - 1253",
      columns: { fileName: "Filename" },
    };
    const a = await analyze(files, opts);
    expect(a.client.requestRows).toBe(982);
    expect(a.templates[0]!.templateRows).toBe(982);
    expect([...a.templates[0]!.appTypes].sort()).toEqual([
      "IT - Master Services Agreement",
      "IT - Other",
      "IT - Statement of Work",
      "IT Contracts - MSA",
    ]);
    expect(a.filePaths.missingPrefix).toBe(0);
    expect(a.filePaths.preview[0]!.filePath).toMatch(/^AUDIO\//);

    const result = await runRaw(files, opts);
    expect(result.templates[0]!.error ?? "").toBe("");
    expect(result.templates[0]).toMatchObject({ status: "filled", rowsWritten: 982 });
    const docs = result.summary.documents;
    expect(docs.total).toBe(1253);
    expect(docs.completed + docs.needsAttention + docs.pending).toBe(docs.total);
    expect(docs.completed + docs.needsAttention).toBeGreaterThanOrEqual(982);
    // Rows with an amber flag are the ones that need attention.
    const flaggedRows = new Set(
      result.flags
        .filter((f) => f.kind !== "fuzzy")
        .map((f) => f.message.match(/ ([A-Z]+)?(\d+)\)/)?.[2]),
    );
    expect(docs.needsAttention).toBeLessThanOrEqual(flaggedRows.size + 5);
  }, 180_000);
});
