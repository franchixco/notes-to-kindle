import { readFileSync, writeFileSync } from 'node:fs';

function readJson(path) {
	let raw;
	try {
		raw = readFileSync(path, 'utf8');
	} catch (error) {
		throw new Error(`Cannot read ${path}: ${error.message}`);
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`Cannot parse ${path} as JSON: ${error.message}`);
	}
}

function writeJson(path, data) {
	const text = `${JSON.stringify(data, null, '\t')}\n`;
	try {
		writeFileSync(path, text);
	} catch (error) {
		throw new Error(`Cannot write ${path}: ${error.message}`);
	}
}

// Read the version straight from package.json so this script does not depend
// on package-manager lifecycle variables (and so it is safe under any runner).
const pkg = readJson('package.json');
const targetVersion = pkg?.version;
if (typeof targetVersion !== 'string' || targetVersion.length === 0) {
	throw new Error('package.json does not contain a valid "version" string; aborting.');
}

// Read minAppVersion from manifest.json and bump version to target version.
const manifest = readJson('manifest.json');
const { minAppVersion } = manifest;
if (typeof minAppVersion !== 'string' || minAppVersion.length === 0) {
	throw new Error('manifest.json does not contain a valid "minAppVersion" string; aborting.');
}

manifest.version = targetVersion;
writeJson('manifest.json', manifest);

// Update versions.json with target version and minAppVersion from manifest.json,
// but only if the target version is not already in versions.json.
const versions = readJson('versions.json');
if (!(targetVersion in versions)) {
	versions[targetVersion] = minAppVersion;
	writeJson('versions.json', versions);
}

console.log(`Bumped version to ${targetVersion} (minAppVersion ${minAppVersion}).`);
