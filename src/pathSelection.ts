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

  // Membership is decided on the base path, because that is the only form the
  // picker shows. Comparing the raw strings counted a configured
  // `path:average` as unlisted, so unticking the checkbox that represented it
  // did not remove it - the tick vanished and the spec was preserved anyway.
  const specsByBase = new Map<string, string[]>();
  for (const path of configured ?? []) {
    const base = basePathOf(path);
    specsByBase.set(base, [...(specsByBase.get(base) ?? []), path]);
  }

  return [
    // A ticked path keeps whatever was configured for it, so ticking
    // `navigation.speedOverGround` does not throw away the `:average` the
    // operator chose - nor the second entry when they asked for both `:min`
    // and `:max`, which the History API serves as distinct series.
    ...picked.flatMap((path) => specsByBase.get(path) ?? [path]),
    // Unlisted paths never had a checkbox, so the picker cannot express their
    // removal and they survive exactly as configured.
    ...(configured ?? []).filter((path) => !shown.has(basePathOf(path)))
  ];
}
