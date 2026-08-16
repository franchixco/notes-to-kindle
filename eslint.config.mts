import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';

// Brands whose official casing must be preserved in this plugin's UI copy.
const BRANDS = ['Obsidian', 'Amazon', 'Kindle', 'Send to Kindle'];

export default defineConfig([
	globalIgnores([
		'node_modules',
		'dist',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'bun.lock',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['bundle-policy.mjs', 'eslint.config.mts', 'manifest.json', 'test/*.ts'],
					// The test suite is small; the default-project cap must cover
					// every test file so they still get type-aware linting.
					maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 30,
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		files: ['src/**/*.ts'],
		rules: {
			'obsidianmd/ui/sentence-case': [
				'error',
				{
					enforceCamelCaseLower: true,
					brands: BRANDS,
					ignoreWords: ['Content', 'Devices'],
				},
			],
		},
	},
	{
		files: ['test/**/*.ts'],
		rules: {
			'obsidianmd/no-global-this': 'off',
			'import/no-extraneous-dependencies': 'off',
		},
	},
]);
