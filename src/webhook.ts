import {createHmac, timingSafeEqual} from 'node:crypto';

import {ImagineSignatureError} from './error';
import type {VerifyWebhookOptions, WebhookEvent} from './types';

/**
 * Webhook signatures (blooms.ai documentation/imagine/api.md §8):
 *
 *   Blooms-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The HMAC key is the whole secret string as shown in the portal (`whsec_…`), as UTF-8.
 * The message is the ASCII `t`, a dot, then the body's exact bytes. A header may carry
 * several `v1=` values (during a secret rotation); one match is enough. The Java
 * library uses the same rule and the same test vectors (test/vectors/webhook-signature.json).
 */

export const SIGNATURE_HEADER = 'Blooms-Signature';
const DEFAULT_TOLERANCE_SEC = 300;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

type RawBody = Buffer | Uint8Array | string;

function bodyBytes(rawBody: unknown): Buffer {
	if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
	if (rawBody instanceof Uint8Array) return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
	throw new ImagineSignatureError('RAW_BODY_REQUIRED',
		'Pass the raw request body (a Buffer or string), not a parsed object. With Express, use express.raw({ type: \'application/json\' }) on the webhook route.');
}

function hmacHex(secret: string, t: string, body: Buffer): string {
	return createHmac('sha256', secret).update(`${t}.`, 'utf8').update(body).digest('hex');
}

/**
 * The `Blooms-Signature` value blooms.ai would send for this body: for testing your
 * own webhook receiver. `t` is Unix seconds; default now.
 */
export function signWebhook(rawBody: RawBody, secret: string, t: number = Math.floor(Date.now() / 1000)): string {
	if (!secret) throw new ImagineSignatureError('SECRET_MISSING', 'A webhook secret is required.');
	if (!Number.isSafeInteger(t) || t < 0) throw new ImagineSignatureError('SIGNATURE_MALFORMED', 't must be Unix seconds');
	return `t=${t},v1=${hmacHex(secret, String(t), bodyBytes(rawBody))}`;
}

/**
 * Checks a webhook and returns its event. Throws `ImagineSignatureError` when it must
 * not be trusted: answer that with a 400 and act on nothing in it.
 *
 * Order: the header is parsed, the signature checked (constant time), then the
 * timestamp, then the body parsed as JSON.
 */
export function verifyWebhook(
	rawBody: RawBody,
	signatureHeader: string | string[] | null | undefined,
	secret: string,
	options: VerifyWebhookOptions = {},
): WebhookEvent {
	if (typeof secret !== 'string' || !secret) {
		throw new ImagineSignatureError('SECRET_MISSING',
			'A webhook secret is required (whsec_…, shown once when the webhook was created in the portal).');
	}
	const body = bodyBytes(rawBody);

	const header = Array.isArray(signatureHeader) ? signatureHeader.join(',') : signatureHeader;
	if (typeof header !== 'string' || !header.trim()) {
		throw new ImagineSignatureError('SIGNATURE_MISSING', `The ${SIGNATURE_HEADER} header is missing.`);
	}

	let t: string | null = null;
	const signatures: Buffer[] = [];
	for (const part of header.split(',')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const key = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (key === 't') t = value;
		else if (key === 'v1' && HEX_SHA256.test(value.toLowerCase())) signatures.push(Buffer.from(value.toLowerCase(), 'hex'));
	}
	if (t === null || !/^\d{1,12}$/.test(t)) {
		throw new ImagineSignatureError('SIGNATURE_MALFORMED', `The ${SIGNATURE_HEADER} header has no valid t= timestamp.`);
	}
	if (!signatures.length) {
		throw new ImagineSignatureError('SIGNATURE_MALFORMED', `The ${SIGNATURE_HEADER} header has no valid v1= signature.`);
	}

	const expected = Buffer.from(hmacHex(secret, t, body), 'hex');
	let matched = false;
	// Every candidate is compared, so the time taken does not say which one matched.
	for (const candidate of signatures) {
		if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) matched = true;
	}
	if (!matched) {
		throw new ImagineSignatureError('SIGNATURE_MISMATCH',
			'The signature does not match this body and secret: the body was changed, or the secret is wrong.');
	}

	const tolerance = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
	const now = options.now instanceof Date ? Math.floor(options.now.getTime() / 1000)
		: typeof options.now === 'number' ? Math.floor(options.now) : Math.floor(Date.now() / 1000);
	if (Math.abs(now - Number(t)) > tolerance) {
		throw new ImagineSignatureError('SIGNATURE_EXPIRED',
			`The signature's timestamp is more than ${tolerance} seconds from now: it may be a replay, or this server's clock is off.`);
	}

	let event: unknown;
	try {
		event = JSON.parse(body.toString('utf8'));
	} catch {
		throw new ImagineSignatureError('PAYLOAD_INVALID', 'The webhook body is not JSON.');
	}
	if (!event || typeof event !== 'object' || typeof (event as {type?: unknown}).type !== 'string') {
		throw new ImagineSignatureError('PAYLOAD_INVALID', 'The webhook body is not an Imagine event.');
	}
	return event as WebhookEvent;
}
