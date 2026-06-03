import { start } from './server.js';
import { makeApps } from './capabilities/apps.js';

const token = process.env.PC_AGENT_TOKEN ?? '';
if (!token) console.warn('WARNING: PC_AGENT_TOKEN is empty — /run will reject everything.');
start({ capabilities: [makeApps()], token });
