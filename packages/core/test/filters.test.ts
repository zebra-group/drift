import { describe, it, expect } from "vitest";
import { applyTableFilter } from "../src/filters/filters.js";

describe("applyTableFilter", () => {
  const all = ["users", "sessions", "orders", "audit_log", "audit_detail"];

  it("returns everything without a filter", () => {
    expect(applyTableFilter(all)).toEqual(all);
  });

  it("applies include globs", () => {
    expect(applyTableFilter(all, { include: ["audit_*"], exclude: [] })).toEqual(["audit_log", "audit_detail"]);
  });

  it("applies exclude globs", () => {
    expect(applyTableFilter(all, { include: [], exclude: ["sessions"] })).toEqual(
      all.filter((t) => t !== "sessions"),
    );
  });
});
