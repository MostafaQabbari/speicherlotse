import { writeFileSync } from 'node:fs';
import { openApiText } from './openapi.ts';

// Writes the OpenAPI description to services/api/openapi.json (the file the dashboard's client is generated from).
const file = new URL('../openapi.json', import.meta.url);
writeFileSync(file, openApiText());
console.log(`wrote ${file.pathname.replace(/^\/([A-Za-z]:)/, '$1')}`);
