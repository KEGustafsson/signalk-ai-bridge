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

/** The two stored path lists, as the status route and the move route carry them. */
export interface SelectionLists<H> {
  readonly aiDataPaths?: readonly string[];
  readonly history?: H;
}

/**
 * Put the lists a move answered with into the panel's status.
 *
 * Used for a 409 as well as a success: the server answers a stale move (a
 * path another save removed, a list that is not stored) with the lists as
 * they now are, and patching from them is what makes the stale entry go away.
 * A list the reply did not carry is kept as it was.
 */
export function withSelectionLists<H, S extends SelectionLists<H>>(previous: S | null, lists: SelectionLists<H>): S | null {
  if (!previous) {
    return previous;
  }
  return {
    ...previous,
    aiDataPaths: lists.aiDataPaths ?? previous.aiDataPaths,
    history: lists.history ?? previous.history
  };
}

/**
 * Apply a status reply without letting it put back an older order.
 *
 * `requestedAt` is the panel's list version when the status read was sent;
 * `current` is the version now. Every time the panel applies a list change
 * from a write (a move's reply, a picker save's re-read) the version goes up,
 * so a status read sent before that change may have been answered from the
 * lists as they were before it - a slow first load landing after a move, say.
 * Such a reply keeps the newer order (the live list, and the history list's
 * paths and whether they are derived) and takes the rest of what it says.
 *
 * `newerShown` says a status read sent after this one has already been
 * applied: then nothing in this reply is newer than the card, and it is
 * dropped whole - otherwise its older model or history counters would replace
 * newer ones.
 */
export function statusKeepingNewerLists<
  H extends { readonly paths?: readonly string[]; readonly derived?: boolean },
  S extends SelectionLists<H>
>(previous: S | null, incoming: S, requestedAt: number, current: number, newerShown = false): S {
  if (previous && newerShown) {
    return previous;
  }
  if (requestedAt === current || !previous) {
    return incoming;
  }
  const history =
    incoming.history && previous.history
      ? { ...incoming.history, paths: previous.history.paths, derived: previous.history.derived }
      : previous.history;
  return { ...incoming, aiDataPaths: previous.aiDataPaths, history };
}

/**
 * The picker's ticks set again from the selection the server says is stored.
 * Used when a move finds the card's list stale: ticks taken from that stale
 * list would put a path another browser removed back on the next Save.
 */
export function retickedFrom(picked: Readonly<Record<string, boolean>>, selected: readonly string[]): Record<string, boolean> {
  const keep = new Set(selected.map((path) => path.split(':')[0]));
  return Object.fromEntries(Object.keys(picked).map((path) => [path, keep.has(path)]));
}
