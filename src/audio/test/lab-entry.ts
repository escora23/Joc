// FRONT ULTRA — audio lab entry for automation (owner: audio). Loaded by lab.html on the dev server only.
import { installLab } from '../lab';

installLab();
const st = document.getElementById('st');
if (st) st.textContent = 'audio lab ready';
(window as unknown as { __labReady: boolean }).__labReady = true;
