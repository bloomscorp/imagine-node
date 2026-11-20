import {ImagineError} from './error';
import type {ReferenceFile} from './types';

/**
 * Reference uploads (blooms.ai documentation/imagine/api.md §4): multipart field
 * `images`, 1–5 files, PNG/JPEG/WebP, ≤ 10 MB each. Checked here before anything is
 * uploaded, with the server's codes, and checked again by the server.
 */

const MB = 1024 * 1024;
export const MAX_REFERENCES = 5;
export const MAX_REFERENCE_BYTES = 10 * MB;
export const REFERENCE_TYPES: ReadonlyArray<string> = ['image/png', 'image/jpeg', 'image/webp'];
const EXTENSIONS: Readonly<Record<string, string>> = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp'};

/** A file ready to upload: a name, a type and a private copy of its bytes. */
export interface PreparedReference {
	filename: string;
	contentType: string;
	bytes: Uint8Array<ArrayBuffer>;
}

/** The type the bytes really are, from their first bytes; null when not PNG, JPEG or WebP. */
export function sniffImageType(bytes: Uint8Array): string | null {
	if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
		&& bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
	if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
	if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
		&& bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
	return null;
}

function fail(code: string, message: string, index: number): never {
	throw new ImagineError(code, message, {details: {reference: index}});
}

async function toBytes(data: unknown, index: number): Promise<Uint8Array<ArrayBuffer>> {
	if (data instanceof Uint8Array) return new Uint8Array(data); // a copy: the caller may reuse its buffer while we retry
	if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
	if (typeof Blob !== 'undefined' && data instanceof Blob) {
		if (data.size > MAX_REFERENCE_BYTES) fail('TOO_LARGE', `reference ${index + 1} is larger than 10 MB`, index);
		return new Uint8Array(await data.arrayBuffer());
	}
	fail('VALIDATION_ERROR', `reference ${index + 1} must be a Buffer, Uint8Array, ArrayBuffer, Blob or { data, filename, contentType }`, index);
}

/** Checks every rule and reads each file once, so every attempt uploads the same bytes. */
export async function prepareReferences(input: ReferenceFile | ReferenceFile[]): Promise<PreparedReference[]> {
	const list = Array.isArray(input) ? input : [input];
	if (list.length === 0) throw new ImagineError('VALIDATION_ERROR', 'Give 1 to 5 reference images.');
	if (list.length > MAX_REFERENCES) {
		throw new ImagineError('TOO_MANY_REFERENCES', `At most ${MAX_REFERENCES} reference images per upload; ${list.length} were given.`);
	}

	const prepared: PreparedReference[] = [];
	for (const [index, item] of list.entries()) {
		if (!item || typeof item !== 'object') fail('VALIDATION_ERROR', `reference ${index + 1} is not a file`, index);

		const wrapped = !(item instanceof Uint8Array) && !(item instanceof ArrayBuffer)
			&& !(typeof Blob !== 'undefined' && item instanceof Blob) && 'data' in item;
		const data = wrapped ? (item as {data: unknown}).data : item;
		const bytes = await toBytes(data, index);
		if (bytes.byteLength === 0) fail('VALIDATION_ERROR', `reference ${index + 1} is empty`, index);
		if (bytes.byteLength > MAX_REFERENCE_BYTES) fail('TOO_LARGE', `reference ${index + 1} is larger than 10 MB`, index);

		const given = wrapped ? (item as {contentType?: unknown}).contentType
			: typeof Blob !== 'undefined' && data instanceof Blob ? data.type : undefined;
		const sniffed = sniffImageType(bytes);
		const contentType = typeof given === 'string' && given.trim() ? given.trim().toLowerCase().split(';')[0]!.trim() : sniffed;
		if (!contentType || !REFERENCE_TYPES.includes(contentType)) {
			fail('BAD_REFERENCE', `reference ${index + 1} must be a PNG, JPEG or WebP image`, index);
		}
		if (sniffed && sniffed !== contentType) {
			fail('BAD_REFERENCE', `reference ${index + 1} says ${contentType} but its bytes are ${sniffed}`, index);
		}

		const rawName = wrapped ? (item as {filename?: unknown}).filename
			: typeof File !== 'undefined' && data instanceof File ? data.name : undefined;
		const cleaned = typeof rawName === 'string'
			? rawName.slice(Math.max(rawName.lastIndexOf('/'), rawName.lastIndexOf('\\')) + 1).replace(/[\u0000-\u001f\u007f"]/g, '').trim()
			: '';
		const filename = cleaned || `reference-${index + 1}.${EXTENSIONS[contentType]}`;
		prepared.push({filename, contentType, bytes});
	}
	return prepared;
}
