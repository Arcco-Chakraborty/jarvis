import { start } from './server.js';
import { makeApps } from './capabilities/apps.js';
import { makeMedia } from './capabilities/media.js';
import { makeShell } from './capabilities/shell.js';
import { makeBrowser } from './capabilities/browser.js';
import { makeType } from './capabilities/type.js';

const token = process.env.PC_AGENT_TOKEN ?? '';
if (!token) console.warn('WARNING: PC_AGENT_TOKEN is empty — /run will reject everything.');
start({ capabilities: [makeApps(), makeMedia(), makeShell(), makeBrowser(), makeType()], token });
