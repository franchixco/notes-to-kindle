import { readFileSync } from 'node:fs';
import process from 'node:process';

const bundle = readFileSync('main.js', 'utf8');
const forbiddenPatterns = [
	'createElement("script")',
	"createElement('script')",
	'new Function',
	'eval(',
];

const failures = [];
for (const pattern of forbiddenPatterns) {
	const count = bundle.split(pattern).length - 1;
	process.stdout.write(`${pattern}: ${count}\n`);
	if (count > 0) failures.push(`${pattern} (${count})`);
}

if (failures.length > 0) {
	process.stderr.write(`error: generated bundle contains forbidden dynamic-code patterns: ${failures.join(', ')}\n`);
	process.exit(1);
}

process.stdout.write('Generated bundle passes dynamic-code policy.\n');
