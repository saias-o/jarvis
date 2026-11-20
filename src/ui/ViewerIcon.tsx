const PATHS = {
  close: 'm6 6 12 12M18 6 6 18',
  expand: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  collapse: 'M3 8h5V3m13 5h-5V3M8 21v-5H3m13 5v-5h5',
  left: 'm14 6-6 6 6 6',
  right: 'm10 6 6 6-6 6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  fit: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M9 9h6v6H9z',
  image: 'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M15 8h.01',
  retry: 'M20 7v5h-5M4 17a8 8 0 0 0 14 1M20 12A8 8 0 0 0 6 6L4 8',
  // Transport. Drawn as strokes like the rest, so a filled triangle would be
  // the one shape here that is a different language.
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M9 5v14M15 5v14',
  previous: 'M18 6v12L9 12zM6 5v14',
  next: 'M6 6v12l9-6zM18 5v14',
}

export function ViewerIcon({ name }: { name: keyof typeof PATHS }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={PATHS[name]} /></svg>
}
