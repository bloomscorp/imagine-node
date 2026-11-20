import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'vitest';

import {Imagine, ImagineError, ImagineSignatureError, manifestKey, parseManifest, signWebhook, verifyWebhook} from '../src';

/**
 * The vectors are shared with imagine-java: change them only together.
 */
interface Vectors {
	secret: string;
	t: number;
	body: string;
	expectedSignature: string;
	expectedHeader: string;
	cases: Array<{name: string; body: string; header: string; secret: string; now: number; toleranceSec: number; valid: boolean; error?: string}>;
}
const vectors: Vectors = JSON.parse(readFileSync(join(__dirname, 'vectors', 'webhook-signature.json'), 'utf8'));
const imagine = new Imagine({apiKey: `blm_live_${'a'.repeat(64)}`, baseUrl: 'http://127.0.0.1:9'});

describe('webhook signatures: shared vectors', () => {
	test('signing the vector body gives the expected header', () => {
		expect(signWebhook(vectors.body, vectors.secret, vectors.t)).toBe(vectors.expectedHeader);
		expect(signWebhook(Buffer.from(vectors.body, 'utf8'), vectors.secret, vectors.t)).toBe(`t=${vectors.t},v1=${vectors.expectedSignature}`);
	});

	test.each(vectors.cases.map(c => [c.name, c] as const))('%s', (_name, c) => {
		const run = () => imagine.webhooks.verify(Buffer.from(c.body, 'utf8'), c.header, c.secret, {now: c.now, toleranceSec: c.toleranceSec});
		if (c.valid) {
			const event = run();
			expect(event).toEqual(JSON.parse(c.body));
		} else {
			let err: unknown;
			try { run(); } catch (e) { err = e; }
			expect(err).toBeInstanceOf(ImagineSignatureError);
			expect(err).toBeInstanceOf(ImagineError);
			expect((err as ImagineSignatureError).code).toBe(c.error);
		}
	});
});

describe('webhooks.verify', () => {
	const {body, secret, t, expectedHeader: header} = vectors;

	test('returns the typed event; a string body works the same as a Buffer', () => {
		const event = verifyWebhook(body, header, secret, {now: new Date(t * 1000)});
		expect(event.type).toBe('imagine.images.ready');
		if (event.type === 'imagine.images.ready') {
			expect(event.data.images[0]!.destination!.bucket).toBe('acme-images');
			expect(event.data.manifestKey).toMatch(/manifest-0001\.json$/);
		}
	});

	test('the default tolerance is 300 seconds, against the real clock', () => {
		const now = Math.floor(Date.now() / 1000);
		expect(() => verifyWebhook(body, signWebhook(body, secret, now - 299), secret)).not.toThrow();
		expect(() => verifyWebhook(body, signWebhook(body, secret, now - 400), secret)).toThrow(expect.objectContaining({code: 'SIGNATURE_EXPIRED'}));
		expect(() => verifyWebhook(body, signWebhook(body, secret, now - 400), secret, {toleranceSec: 600})).not.toThrow();
	});

	test('a parsed body is refused with a pointer to express.raw()', () => {
		let err: any;
		try { verifyWebhook(JSON.parse(body), header, secret, {now: t}); } catch (e) { err = e; }
		expect(err.code).toBe('RAW_BODY_REQUIRED');
		expect(err.message).toContain('express.raw');
	});

	test('a missing header or secret is refused', () => {
		expect(() => verifyWebhook(body, undefined, secret, {now: t})).toThrow(expect.objectContaining({code: 'SIGNATURE_MISSING'}));
		expect(() => verifyWebhook(body, header, '', {now: t})).toThrow(expect.objectContaining({code: 'SECRET_MISSING'}));
	});

	test('a header given as a list (repeated header) is joined', () => {
		const [tPart, v1Part] = header.split(',');
		expect(verifyWebhook(body, [tPart!, v1Part!], secret, {now: t}).id).toBe(JSON.parse(body).id);
	});

	test('a correctly signed body that is not an event is PAYLOAD_INVALID', () => {
		for (const raw of ['not json', '[]', '{"id":"evt_1"}']) {
			expect(() => verifyWebhook(raw, signWebhook(raw, secret, t), secret, {now: t}))
				.toThrow(expect.objectContaining({code: 'PAYLOAD_INVALID'}));
		}
	});

	test('one changed byte anywhere in the body fails', () => {
		const bytes = Buffer.from(body, 'utf8');
		for (const i of [0, Math.floor(bytes.length / 2), bytes.length - 1]) {
			const copy = Buffer.from(bytes);
			copy[i] = copy[i]! ^ 1;
			expect(() => verifyWebhook(copy, header, secret, {now: t})).toThrow(expect.objectContaining({code: 'SIGNATURE_MISMATCH'}));
		}
	});
});

describe('manifests', () => {
	const manifest = {
		jobId: '6573a1b2c3d4e5f607182931', n: 1,
		images: [{seq: 0, imageId: 'i0', key: 'imagine/6573a1b2c3d4e5f607182931/000000-i0.png', externalRef: 'sku-1', prompt: 'p',
			mimeType: 'image/png', width: 1024, height: 1024, bytes: 1534211, sha256: 'a'.repeat(64)}],
	};

	test('parses a string, bytes or an object', () => {
		for (const input of [JSON.stringify(manifest), Buffer.from(JSON.stringify(manifest)), manifest]) {
			expect(imagine.manifests.parse(input)).toEqual(manifest);
		}
		expect(parseManifest({...manifest, images: [{...manifest.images[0], externalRef: undefined}]}).images[0]!.externalRef).toBeNull();
	});

	test.each([
		['not JSON', '{'],
		['not an object', '[]'],
		['no jobId', {...manifest, jobId: ''}],
		['no n', {...manifest, n: '1'}],
		['no images', {...manifest, images: null}],
		['an image without a key', {...manifest, images: [{seq: 0, imageId: 'i0'}]}],
		['a bad sha256', {...manifest, images: [{...manifest.images[0], sha256: 'xyz'}]}],
	])('BAD_MANIFEST: %s', (_label, input) => {
		expect(() => parseManifest(input as any)).toThrow(expect.objectContaining({code: 'BAD_MANIFEST'}));
	});

	test('the key follows the layout {prefix}{jobId}/manifest-{n:0000}.json', () => {
		expect(manifestKey('imagine/', 'job1', 7)).toBe('imagine/job1/manifest-0007.json');
		expect(imagine.manifests.key('', 'job1', 12345)).toBe('job1/manifest-12345.json');
	});
});
