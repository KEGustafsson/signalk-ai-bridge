/**
 * Merging a picker's ticks with the selection already stored for the plugin.
 *
 * Kept out of the panel because it is the only part of the save path with
 * rules of its own, and a pure function is what lets the suite exercise them
 * without compiling React.
 */

/**
 * A history path may carry an aggregation method: `navigation.speedOverGround`
 * is listed by the picker, but the stored selection can be
 * `navigation.speedOverGround:average`, and both are one path.
 */
function basePathOf(path: string): string {
  return path.split(':')[0];
}

export function withUnlistedSelection(
  picked: readonly string[],
  listed: readonly string[],
  configured: readonly string[] | undefined
): string[] {
  const shown = new Set(listed);
  const ticked = new Set(picked);

  // Membership is decided on the base path, because that is the only form the
  // picker shows. Comparing the raw strings counted a configured
  // `path:average` as unlisted, so unticking the checkbox that represented it
  // did not remove it - the tick vanished and the spec was preserved anyway.
  const configuredBases = new Set((configured ?? []).map(basePathOf));

  const kept = (configured ?? []).filter((path) => {
    const base = basePathOf(path);
    // Unlisted paths never had a checkbox, so the picker cannot express their
    // removal and they survive exactly as configured. A listed one stays if it
    // is still ticked - with whatever was configured for it, so ticking
    // `navigation.speedOverGround` keeps the `:average` the operator chose, and
    // both entries when they asked for `:min` and `:max`.
    return !shown.has(base) || ticked.has(base);
  });

  // The stored order is the operator's priority order (the prompt budget keeps
  // earlier entries first), so a save from the picker keeps it and adds newly
  // ticked paths at the end rather than re-sorting everything into list order.
  const added = picked.filter((path) => !configuredBases.has(path));

  return [...new Set([...kept, ...added])];
}

/**
 * The selection with one entry moved `delta` places (-1 up, +1 down), or the
 * same list when the move would leave the ends.
 */
export function movePath(list: readonly string[], index: number, delta: number): string[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}
