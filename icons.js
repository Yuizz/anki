// Íconos SVG de trazo, propios. Heredan el color del texto (currentColor).

const P = {
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  sound: '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.8a4.5 4.5 0 0 1 0 6.4"/><path d="M18.4 6a8.5 8.5 0 0 1 0 12"/>',
  sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  upload: '<path d="M20 15v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3"/><path d="m16 8-4-4-4 4"/><path d="M12 4v11"/>',
  download: '<path d="M20 15v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3"/><path d="m8 11 4 4 4-4"/><path d="M12 4v11"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6"/><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
  reset: '<path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  shuffle: '<path d="M3 7h3.5c2.5 0 3.8 1.2 5 3.5l1 2c1.2 2.3 2.5 3.5 5 3.5H21"/><path d="M3 17h3.5c1.4 0 2.4-.4 3.2-1.1M14.3 8.1c.8-.7 1.8-1.1 3.2-1.1H21"/><path d="m18 4 3 3-3 3M18 14l3 3-3 3"/>',
  flame: '<path d="M12 21c3.9 0 6.5-2.7 6.5-6.3 0-3.3-2-5.6-4-7.7-.4 1.9-1.3 3.1-2.6 3.8.2-2.9-.8-5.6-3-7.8C9 6.4 5.5 9.4 5.5 14.7 5.5 18.3 8.1 21 12 21z"/>',
  cards: '<rect x="3" y="7" width="13" height="13" rx="2"/><path d="M8 4h11a2 2 0 0 1 2 2v11"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  share: '<path d="M8 10H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-2"/><path d="m16 6-4-4-4 4"/><path d="M12 2v12"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  offline: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.5" r=".6" fill="currentColor"/><path d="M1.5 9a15 15 0 0 1 21 0"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 4 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4a2 2 0 0 0-3.4 0z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${P[name] || ''}</svg>`;
}
