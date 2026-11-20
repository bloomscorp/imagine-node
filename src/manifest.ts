import {ImagineError} from './error';
import type {Manifest, ManifestImage} from './types';

/**
 * Manifests (blooms.ai documentation/imagine/api.md §7): one JSON file per
 * `imagine.images.ready`, written to the destination at
 * `{prefix}{jobId}/manifest-{n:0000}.json`.
 */

function bad(message: string): never {
	throw new ImagineError('BAD_MANIFEST', message);
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/**
 * Parses and checks a manifest read from your bucket: a string, the file's bytes, or
 * an already-parsed object. Throws `ImagineError` `BAD_MANIFEST` when it is not one.
 */
export function parseManifest(json: string | Buffer | Uint8Array | object): Manifest {
	let value: unknown = json;
	if (typeof json === 'string' || json instanceof Uint8Array) {
		const text = typeof json === 'string' ? json : Buffer.from(json.buffer, json.byteOffset, json.byteLength).toString('utf8');
		try {
			value = JSON.parse(text);
		} catch {
			bad('The manifest is not JSON.');
		}
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) bad('The manifest is not an object.');
	const m = value as Record<string, unknown>;
	if (!isText(m.jobId)) bad('The manifest has no jobId.');
	if (!isCount(m.n)) bad('The manifest has no number n.');
	if (!Array.isArray(m.images)) bad('The manifest has no images list.');

	const images = m.images.map((raw, i): ManifestImage => {
		if (!raw || typeof raw !== 'object') bad(`Manifest image ${i} is not an object.`);
		const img = raw as Record<string, unknown>;
		if (!isCount(img.seq)) bad(`Manifest image ${i} has no seq.`);
		if (!isText(img.imageId)) bad(`Manifest image ${i} has no imageId.`);
		if (!isText(img.key)) bad(`Manifest image ${i} has no key.`);
		if (img.sha256 !== undefined && img.sha256 !== null && !(typeof img.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(img.sha256))) {
			bad(`Manifest image ${i} has a sha256 that is not 64 hex characters.`);
		}
		return {
			...img,
			seq: img.seq,
			imageId: img.imageId,
			key: img.key,
			externalRef: typeof img.externalRef === 'string' ? img.externalRef : null,
		} as ManifestImage;
	});
	return {...(m as object), jobId: m.jobId, n: m.n, images} as Manifest;
}

/** The manifest's object key for batch `n` of a job, as blooms.ai writes it. */
export function manifestKey(prefix: string, jobId: string, n: number): string {
	return `${prefix}${jobId}/manifest-${String(n).padStart(4, '0')}.json`;
}
