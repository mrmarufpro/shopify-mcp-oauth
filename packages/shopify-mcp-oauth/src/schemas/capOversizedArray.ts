// zod validates every array element's shape before any .max()/.refine() check runs, so a bounded
// count check or refine alone still pays O(n) to parse an oversized array's elements. Replace an
// over-cap array with a fixed-size placeholder before it reaches the real schema, so a hostile
// array of any size costs the same to reject as one just over the limit — a downstream .max()
// check still fires on the placeholder and reports the same message.
//
// Internal to src/schemas/ — not part of this package's public export surface.
export function capOversizedArray(value: unknown, cap: number): unknown {
  if (Array.isArray(value) && value.length > cap) {
    return Array.from({ length: cap + 1 }, () => "");
  }
  return value;
}
