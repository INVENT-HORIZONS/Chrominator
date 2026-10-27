// Applies the saved light/dark choice before the panel draws, so it doesn't flash the other theme.
// Loaded as a classic script in <head> (MV3 forbids inline scripts). ui.js handles the switch.
try {
  const t = localStorage.getItem('chrominator.theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {}
