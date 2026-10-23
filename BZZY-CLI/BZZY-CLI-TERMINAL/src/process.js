import { fileURLToPath } from 'node:url';
export * from '@bzzy/core/engine/process.js';
export const root = fileURLToPath(new URL('../', import.meta.url));
