// @vitest-environment node
import { describe, expect, it } from "vitest";

import { matchTemplates, nameSimilarity, templateLabel } from "@/server/transform/appTypes";
import { suggestOption } from "@/server/transform/dropdowns";
import { autoMap, parseCsv } from "@/server/transform/mapping";
import { DEFAULT_PREFIX } from "@/lib/transform/types";
import { buildFilePath } from "@/server/transform/pipeline";
import { excelSerialToIso, looseHeader } from "@/server/transform/read";
import { shiftRefs } from "@/server/transform/workbook";

const PREFIX = "https://contractpodai.sharepoint.com/sites/";

describe("buildFilePath", () => {
  it("strips the prefix and appends the file name", () => {
    expect(
      buildFilePath(
        "https://contractpodai.sharepoint.com/sites/Enstructure/Shared Documents/Client folder/LegacyMigration/Enstructure-Contracts-Upload/contracts-upload-061726/contracts/Enstructure/Corporate/Vendors_Consultants/",
        "Aviation Portfolio - Enstructure LLC - 2024 - 5_15_2024.pdf",
        PREFIX,
      ),
    ).toEqual({
      path: "Enstructure/Shared Documents/Client folder/LegacyMigration/Enstructure-Contracts-Upload/contracts-upload-061726/contracts/Enstructure/Corporate/Vendors_Consultants/Aviation Portfolio - Enstructure LLC - 2024 - 5_15_2024.pdf",
      prefixFound: true,
    });
  });

  it("keeps brackets and parentheses and adds a missing trailing slash", () => {
    expect(
      buildFilePath(
        `${PREFIX}Enstructure/Shared Documents/Client folder/LegacyMigration/Enstructure-Contracts-Upload/contracts-upload-061726/contracts/Enstructure/Corporate/HR/NDAs`,
        "Criterion NDA 20250910.1 (Executed) [Fully Executed].pdf",
        PREFIX,
      ).path,
    ).toBe(
      "Enstructure/Shared Documents/Client folder/LegacyMigration/Enstructure-Contracts-Upload/contracts-upload-061726/contracts/Enstructure/Corporate/HR/NDAs/Criterion NDA 20250910.1 (Executed) [Fully Executed].pdf",
    );
  });

  it("removes everything up to a later part of the path", () => {
    expect(
      buildFilePath(
        `${PREFIX}Enstructure/Shared Documents/Client folder/LegacyMigration/Enstructure-Contracts-Upload/contracts-upload-061726/contracts/Enstructure/Corporate/Vendors_Consultants/`,
        "Aviation Portfolio - Enstructure LLC - 2024 - 5_15_2024.pdf",
        DEFAULT_PREFIX,
      ),
    ).toEqual({
      path: "Enstructure-Contracts-Upload/contracts-upload-061726/contracts/Enstructure/Corporate/Vendors_Consultants/Aviation Portfolio - Enstructure LLC - 2024 - 5_15_2024.pdf",
      prefixFound: true,
    });
  });

  it("reports a folder that lacks the prefix", () => {
    expect(buildFilePath("https://other.example.com/x/", "a.pdf", PREFIX).prefixFound).toBe(false);
  });
});

describe("header matching", () => {
  it("aliases custom fields and strips notes", () => {
    expect(looseHeader("Application Type Custom Fields(TerminalLocation)")).toBe(
      "terminal location",
    );
    expect(looseHeader("Assignee (Only 1 Email ID)")).toBe("assignee");
    expect(looseHeader("Is final signed copy?")).toBe("is final signed copy");
  });

  it("maps exact before alias and marks mandatory/reserved columns", () => {
    const { entries } = autoMap(
      [
        "Record Reference Id",
        "Party Name",
        "Assignee",
        "Effective Date",
        "Application Type Custom Fields(Region)",
      ],
      [
        "Party Name (Counterparty Name)",
        "Assignee (Only 1 Email ID)",
        "Effective Date (Uploads)",
        "Effective Date",
        "Region",
      ],
      { dropdownHeaders: new Set(["Party Name"]), mandatory: ["Party Name", "Assignee"] },
    );
    expect(entries.map((e) => [e.template, e.client, e.source])).toEqual([
      ["Record Reference Id", null, "none"],
      ["Party Name", "Party Name (Counterparty Name)", "alias"],
      ["Assignee", "Assignee (Only 1 Email ID)", "alias"],
      ["Effective Date", "Effective Date", "exact"],
      ["Application Type Custom Fields(Region)", "Region", "alias"],
    ]);
    expect(entries[0]!.reserved).toBe(true);
    expect(entries[1]!.mandatory && entries[1]!.dropdown).toBe(true);
  });

  it("maps common client wordings through synonyms", () => {
    const { entries } = autoMap(
      ["Party Name", "Address Line 1", "Address Line 2", "Country", "Expiration Date"],
      [
        "Counterparty Name 1 ",
        "Counterparty Name2",
        "Street 2",
        "Street 1",
        "Counterparty Country",
        "Expiry Date",
      ],
      { dropdownHeaders: new Set(), mandatory: [] },
    );
    expect(entries.map((e) => e.client)).toEqual([
      "Counterparty Name 1 ",
      "Street 1",
      "Street 2",
      "Counterparty Country",
      "Expiry Date",
    ]);
  });

  it("lets the mapping file override automatic matches", () => {
    const { entries, warnings } = autoMap(
      ["Effective Date"],
      ["Effective Date", "Effective Date (Uploads)"],
      {
        dropdownHeaders: new Set(),
        mandatory: [],
        pairs: [
          { client: "Effective Date (Uploads)", template: "Effective Date" },
          { client: "Nope", template: "Effective Date" },
        ],
      },
    );
    expect(entries[0]).toMatchObject({ client: "Effective Date (Uploads)", source: "file" });
    expect(warnings).toHaveLength(1);
  });

  it("parses quoted CSV", () => {
    expect(
      parseCsv(
        'Client Column,Template Column\r\n"Region","Application Type Custom Fields(Region)"\n',
      ),
    ).toEqual([
      ["Client Column", "Template Column"],
      ["Region", "Application Type Custom Fields(Region)"],
    ]);
  });
});

describe("template app types", () => {
  it("reads the app type from the file name", () => {
    expect(templateLabel("NDA_Aug_20.xlsx")).toBe("NDA");
    expect(templateLabel("Copy of Rate_Sheet_Agreement_Sep_2026 (2).xlsx")).toBe(
      "Rate Sheet Agreement",
    );
    expect(templateLabel("Vendor Agreement - Template v2.xlsm")).toBe("Vendor Agreement");
  });

  it("scores names", () => {
    expect(nameSimilarity("NDA", "NDA")).toBe(1);
    expect(nameSimilarity("NDA", "NDA Agreement")).toBeGreaterThan(0.85);
    expect(nameSimilarity("Property Leases", "Property Lease")).toBeGreaterThan(0.7);
    expect(nameSimilarity("NDA", "Property Lease")).toBeLessThan(0.5);
  });

  it("assigns each app type to one template, using system names and row counts", () => {
    const appTypes = [
      { name: "NDA Agreement", count: 67, systemName: "NDA" },
      { name: "Rate Sheet", count: 258, systemName: "Rate Sheet Agreement" },
      { name: "Other Commercial Agreement", count: 280, systemName: "Other Commercial Agreement" },
      { name: "Vendor Agreement", count: 367, systemName: "Vendor Agreement" },
    ];
    const matches = matchTemplates(
      [
        { label: "Rate Sheet Agreement", rows: 258 },
        { label: "NDA", rows: 67 },
        { label: "Other Commercial", rows: 280 },
        { label: "NDA", rows: 67 },
        { label: "Unrelated", rows: 3 },
      ],
      appTypes,
    );
    expect(matches.map((m) => m.appTypes)).toEqual([
      ["Rate Sheet"],
      ["NDA Agreement"],
      ["Other Commercial Agreement"],
      [],
      [],
    ]);
  });

  it("combines related app types whose row counts add up to the template's rows", () => {
    const appTypes = [
      { name: "IT - Statement of Work", count: 377, systemName: null },
      { name: "IT - Other", count: 351, systemName: null },
      { name: "IT - Master Services Agreement", count: 253, systemName: null },
      { name: "IT Contracts - MSA", count: 1, systemName: null },
      { name: "Audio - Permissions", count: 1, systemName: null }, // unrelated, same size
    ];
    const [match] = matchTemplates([{ label: "IT Agreements", rows: 982 }], appTypes);
    expect(match!.appTypes.sort()).toEqual([
      "IT - Master Services Agreement",
      "IT - Other",
      "IT - Statement of Work",
      "IT Contracts - MSA",
    ]);
    expect(match!.score).toBeGreaterThanOrEqual(0.6);
    // No combination adds up: nothing is guessed.
    expect(matchTemplates([{ label: "IT Agreements", rows: 5 }], appTypes)[0]!.appTypes).toEqual(
      [],
    );
  });
});

describe("values", () => {
  it("suggests the closest dropdown option", () => {
    expect(suggestOption("Other", ["Customer", "Vendor", "Others", "Lessor"])).toBe("Others");
    expect(suggestOption("united states", ["United States", "India"])).toBe("United States");
    expect(suggestOption("Zzzzzz", ["Customer"])).toBeUndefined();
  });

  it("matches whole words only when one option fits", () => {
    expect(suggestOption("United States", ["United States of America", "India"])).toBe(
      "United States of America",
    );
    expect(
      suggestOption("United States", [
        "United States of America",
        "United States Minor Outlying Islands",
      ]),
    ).toBeUndefined();
    expect(suggestOption("Cat", ["Bat", "Hat"])).toBeUndefined(); // equally close: ambiguous
  });

  it("turns fuzzy matching on for dropdowns except Party Name and Legal Party", () => {
    const { entries } = autoMap(
      ["Party Name", "Party Type", "Legal Party", "Description"],
      ["Party Name", "Party Type", "Legal Party", "Description"],
      { dropdownHeaders: new Set(["Party Name", "Party Type", "Legal Party"]), mandatory: [] },
    );
    expect(entries.map((e) => e.fuzzy)).toEqual([false, true, false, false]);
  });

  it("converts Excel serial dates to yyyy-mm-dd", () => {
    expect(excelSerialToIso(45911)).toBe("2025-09-11");
    expect(excelSerialToIso(45047)).toBe("2023-05-01");
  });

  it("shifts ranges for an inserted column", () => {
    expect(shiftRefs("I2:I1000 B2:D5 A1", 2)).toBe("J2:J1000 B2:E5 A1");
    expect(shiftRefs("$C$3", 2)).toBe("$D$3");
  });
});
