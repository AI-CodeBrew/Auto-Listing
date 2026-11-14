/** Tells the top bar that the list of stores changed, so its store chooser updates at once. */
export const STORES_CHANGED = "fynk-stores-changed";

export function announceStoresChanged(): void {
  window.dispatchEvent(new Event(STORES_CHANGED));
}
