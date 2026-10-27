// Applies the light/dark theme before the page draws, so it doesn't flash the other one.
// Dark is the default; the ☀/☾ switch in the side panel saves the user's choice.
// Loaded as a classic script in <head> (MV3 forbids inline scripts). ui.js handles the switch.
let theme = 'dark';
try {
  const t = localStorage.getItem('chrominator.theme');
  if (t === 'light' || t === 'dark') theme = t;
} catch {}
document.documentElement.dataset.theme = theme;
