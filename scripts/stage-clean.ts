import { cpSync, mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
// No existing files are deleted. Each clean-install check gets a fresh, bounded workspace directory.
const parent = resolve('artifacts/test-work'); mkdirSync(parent, { recursive: true });
const target = mkdtempSync(resolve(parent, 'clean-install-'));
for (const name of ['apps', 'packages', 'tests', 'scripts', 'examples', 'fixtures', 'sources', 'skills', 'docs', '.github', 'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', '.env.example', 'NOTICE.md']) cpSync(resolve(name), resolve(target, name), { recursive: true });
writeFileSync(resolve('artifacts/clean-install-path.txt'), target + '\n');
console.log(target);
