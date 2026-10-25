// Runs in an extension tab. Chrome can't show the serial port picker inside the side panel
// (or a popup-type window), so the side panel opens this page in a normal tab; the user picks the
// port here and the result (index in navigator.serial.getPorts() plus USB info) is sent back.
async function closeSelf() {
  try { const t = await chrome.tabs.getCurrent(); if (t) { await chrome.tabs.remove(t.id); return; } } catch {}
  window.close();
}

document.getElementById('btnChoose').onclick = async () => {
  const t0 = performance.now();
  let msg;
  try {
    const p = await navigator.serial.requestPort();
    const ports = await navigator.serial.getPorts();
    msg = { type: 'port-chosen', index: ports.indexOf(p), info: p.getInfo() };
  } catch (e) {
    if (e.name === 'NotFoundError' && performance.now() - t0 > 700) {
      msg = { type: 'port-cancelled' };                       // picker was shown, user cancelled
    } else {
      // Picker never appeared. Stay open and show Chrome's own error so it can be diagnosed.
      const text = `Chrome did not show the port picker: ${e.name}: ${e.message}`;
      document.getElementById('err').textContent = text;
      try { await chrome.runtime.sendMessage({ type: 'port-error', message: text }); } catch {}
      return;
    }
  }
  try { await chrome.runtime.sendMessage(msg); } catch {}
  closeSelf();
};
