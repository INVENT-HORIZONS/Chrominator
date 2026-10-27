// Regular pop-out oscilloscope window (scope.html?ch=N): the fallback when the side panel can't
// open a Picture-in-Picture window itself. Its "Keep on top" button moves the scope into a
// Picture-in-Picture window (always on top) and minimizes this one; closing the PiP brings it back.
import { ScopeView, openPipScope } from './scopeview.js';

const CH = +new URLSearchParams(location.search).get('ch') || 0;
let view = null;

function showHere() { view = new ScopeView(document, CH, { onPin: keepOnTop }); }

async function keepOnTop() {
  let pip;
  try { pip = await openPipScope(CH, { width: innerWidth, height: innerHeight }); }
  catch (e) { alert(`Chrome refused the always-on-top window: ${e.message}`); return; }
  view.destroy(); view = null;
  document.body.classList.add('pinned');
  const note = document.createElement('p');
  note.className = 'pinnednote';
  note.textContent = 'This scope is in an always-on-top window. Closing that window brings it back here.';
  document.body.append(note);
  const me = await chrome.windows.getCurrent();
  chrome.windows.update(me.id, { state: 'minimized' }).catch(() => {});
  pip.addEventListener('pagehide', () => {
    note.remove();
    document.body.classList.remove('pinned');
    showHere();
    chrome.windows.update(me.id, { state: 'normal', focused: true }).catch(() => {});
  });
}

showHere();
