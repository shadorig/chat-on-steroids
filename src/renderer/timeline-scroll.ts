export interface TimelineViewport {
  bottom: boolean;
  key: string | null;
  offset: number;
  scrollTop: number;
}

const timelineRows = (timeline: HTMLElement): HTMLElement[] =>
  [...timeline.querySelectorAll<HTMLElement>('[data-timeline-key]')].filter(row => !row.matches('.tool-group[open]'));

/** Captures a logical row rather than a raw pixel so later height changes above it are harmless. */
export function captureTimelineViewport(
  pane: HTMLElement,
  timeline: HTMLElement,
  followBottom = true
): TimelineViewport {
  const previous = pane.scrollTop;
  const bottom = followBottom && previous + pane.clientHeight >= pane.scrollHeight - 40;
  const edge = pane.getBoundingClientRect().top;
  const anchor = bottom ? undefined : timelineRows(timeline).find(row => {
    const rect = row.getBoundingClientRect();
    return rect.height > 0 && rect.bottom > edge && rect.top < edge + pane.clientHeight;
  });
  return {
    bottom,
    key: anchor?.dataset.timelineKey ?? null,
    offset: anchor ? anchor.getBoundingClientRect().top - edge : 0,
    scrollTop: previous
  };
}

export function restoreTimelineViewport(
  pane: HTMLElement,
  timeline: HTMLElement,
  viewport: TimelineViewport
): void {
  if (viewport.bottom) { pane.scrollTop = pane.scrollHeight; return; }
  const current = viewport.key ? timelineRows(timeline).find(row => row.dataset.timelineKey === viewport.key) : undefined;
  const rect = current?.getBoundingClientRect();
  pane.scrollTop = rect && rect.height > 0
    ? pane.scrollTop + rect.top - pane.getBoundingClientRect().top - viewport.offset
    : viewport.scrollTop;
}

/** Capture the visible logical row for one synchronous reconciliation. */
export function preserveTimelineViewport(pane: HTMLElement, timeline: HTMLElement, followBottom = true): () => void {
  const viewport = captureTimelineViewport(pane, timeline, followBottom);
  return () => {
    restoreTimelineViewport(pane, timeline, viewport);
  };
}
