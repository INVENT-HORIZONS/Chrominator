// Pop-out oscilloscope window (scope.html?ch=N): one channel in its own resizable window, with its
// own timebase, scale, pause and CSV. The side panel keeps drawing the channel too.
import { ScopeView } from './scopeview.js';
import { SCOPE_CHANNEL } from './scopebridge.js';

const CH = +new URLSearchParams(location.search).get('ch') || 0;
new ScopeView(document, CH);

// The side panel disconnected: close this window.
const bc = new BroadcastChannel(SCOPE_CHANNEL);
bc.onmessage = ({ data: m }) => { if (m?.type === 'close') window.close(); };
