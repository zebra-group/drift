import micromatch from "micromatch";
import type { TableFilter } from "../vault/types.js";

export function applyTableFilter(tables: string[], filter?: TableFilter): string[] {
  if (!filter) return [...tables];
  const include = filter.include.length ? filter.include : ["**"];
  let result = micromatch(tables, include);
  if (filter.exclude.length) result = result.filter((t) => !micromatch.isMatch(t, filter.exclude));
  return result;
}
