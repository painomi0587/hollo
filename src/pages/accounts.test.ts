import { describe, expect, it } from "vitest";

import { parseFields } from "./accounts";

describe("parseFields", () => {
  it("preserves custom field values longer than 255 characters", () => {
    const form = new FormData();
    const longValue = `[${"example ".repeat(40)}](https://example.com)`;

    form.set("fields[0][name]", "Links");
    form.set("fields[0][value]", ` ${longValue} `);

    expect(parseFields(form)).toEqual([{ name: "Links", value: longValue }]);
  });

  it("keeps custom field labels limited to 255 characters", () => {
    const form = new FormData();

    form.set("fields[0][name]", "A".repeat(300));
    form.set("fields[0][value]", "https://example.com");

    expect(parseFields(form)).toEqual([
      { name: "A".repeat(255), value: "https://example.com" },
    ]);
  });
});
