// 선 아이콘 (장식이라 aria-hidden)
const P = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, 'aria-hidden': true } as const;
export const Plus = () => <svg {...P}><path d="M12 5v14M5 12h14" /></svg>;
export const Gear = () => <svg {...P}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></svg>;
export const Back = () => <svg {...P}><path d="M15 18l-6-6 6-6" /></svg>;
export const Play = () => <svg {...P} fill="currentColor" stroke="none"><path d="M7 4l13 8-13 8z" /></svg>;
export const Warn = () => <svg {...P} width={16} height={16} style={{ flex: '0 0 auto', marginTop: 2, color: 'var(--fg-warn)' }}><path d="M12 3l9 16H3z" /><path d="M12 10v4M12 17h.01" /></svg>;
export const Close = () => <svg {...P} width={16} height={16}><path d="M6 6l12 12M18 6L6 18" /></svg>;
