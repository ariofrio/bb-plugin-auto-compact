/* The SDK has additive sections but no native-form replacement slot.
   Hide the fallback only while our settings section renders successfully. */
export function replaceNativeSettings(section: HTMLElement): () => void {
  const detail = section.closest('[data-testid="plugin-detail-auto-compact"]');
  if (detail === null) return () => {};
  const hidden = new Map<HTMLElement, { value: string; priority: string }>();
  const sync = () => {
    for (const child of Array.from(detail.children)) {
      if (!(child instanceof HTMLElement) || child.contains(section)) continue;
      if (!child.querySelector('[aria-label="Global auto-compaction default"]')) continue;
      if (!hidden.has(child)) {
        hidden.set(child, {
          value: child.style.getPropertyValue("display"),
          priority: child.style.getPropertyPriority("display"),
        });
      }
      child.style.setProperty("display", "none");
    }
  };
  const observer = new MutationObserver(sync);
  observer.observe(detail, { childList: true, subtree: true });
  sync();
  return () => {
    observer.disconnect();
    for (const [element, previous] of hidden) {
      element.style.setProperty("display", previous.value, previous.priority);
    }
  };
}
