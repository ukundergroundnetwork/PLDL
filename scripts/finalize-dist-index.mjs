import { rename } from 'node:fs/promises';
import { join } from 'node:path';

const distDir = 'dist';
const templatePath = join(distDir, 'template.html');
const indexPath = join(distDir, 'index.html');

await rename(templatePath, indexPath);
