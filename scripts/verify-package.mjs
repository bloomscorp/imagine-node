// The packaging gate: what `npm publish` would ship loads, in both module systems,
// and carries no source, tests, examples or secrets.
import {execSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';

const fail = (msg) => { console.error(`verify-package: ${msg}`); process.exit(1); };

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const packed = JSON.parse(execSync('npm pack --dry-run --json', {encoding: 'utf8'}))[0];
const files = packed.files.map(f => f.path).sort();
const allowed = ['LICENSE.md', 'README.md', 'dist/index.d.mts', 'dist/index.d.ts', 'dist/index.js', 'dist/index.mjs', 'package.json'];
const extra = files.filter(f => !allowed.includes(f));
const missing = allowed.filter(f => !files.includes(f));
if (extra.length) fail(`unexpected files in the package: ${extra.join(', ')}`);
if (missing.length) fail(`missing from the package: ${missing.join(', ')}`);

// Provenance needs the repository in the published manifest, naming the GitHub repo.
if (pkg.repository?.url !== 'https://github.com/bloomscorp/imagine-node') fail('package.json repository.url must be https://github.com/bloomscorp/imagine-node');
if (pkg.dependencies && Object.keys(pkg.dependencies).length) fail(`no runtime dependencies allowed: ${Object.keys(pkg.dependencies).join(', ')}`);

const require = createRequire(import.meta.url);
const cjs = require('../dist/index.js');
const esm = await import('../dist/index.mjs');
const values = ['Imagine', 'ImagineError', 'ImagineSignatureError', 'verifyWebhook', 'signWebhook', 'parseManifest', 'manifestKey'];
for (const [name, mod] of [['cjs', cjs], ['esm', esm]]) {
	for (const v of values) if (typeof mod[v] !== 'function') fail(`${name} build does not export ${v}`);
	if (mod.VERSION !== pkg.version) fail(`${name} VERSION ${mod.VERSION} does not match package.json ${pkg.version}`);
	if (mod.SIGNATURE_HEADER !== 'Blooms-Signature') fail(`${name} SIGNATURE_HEADER is wrong`);
}

// The built code signs the shared vectors the same way the source does.
const vectors = JSON.parse(readFileSync(new URL('../test/vectors/webhook-signature.json', import.meta.url), 'utf8'));
for (const [name, mod] of [['cjs', cjs], ['esm', esm]]) {
	if (mod.signWebhook(vectors.body, vectors.secret, vectors.t) !== vectors.expectedHeader) fail(`${name} build signs the vector differently`);
}

for (const d of ['dist/index.d.ts', 'dist/index.d.mts']) {
	const text = readFileSync(new URL(`../${d}`, import.meta.url), 'utf8');
	for (const t of ['CreateJobRequest', 'WebhookEvent', 'ImagesPage', 'Manifest', 'Session', 'Job', 'Image']) {
		if (!new RegExp(`\\b${t}\\b`).test(text)) fail(`${d} does not declare ${t}`);
	}
}
console.log(`verify-package: ok (${files.length} files, cjs + esm load, version ${cjs.VERSION})`);
