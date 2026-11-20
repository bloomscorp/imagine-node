import {ImagineError} from './error';
import type {CreateJobRequest, CreateSessionOptions} from './types';

/**
 * The contract's hard limits (blooms.ai documentation/imagine/api.md §3, §4, §5, §6),
 * checked before a request is sent so a mistake fails fast with the server's code.
 * Anything that depends on the project (maxItemsPerJob, credentials, models,
 * destinations) is left to the server.
 */

export const LIMITS = {
	ROWS_MAX: 1000,
	ROW_COUNT_MAX: 50,
	NAME_MAX: 120,
	EXTERNAL_REF_MAX: 200,
	NOTIFY_IMAGES_MAX: 1000,
	NOTIFY_MINUTES_MAX: 1440,
	IDEMPOTENCY_KEY_MAX: 200,
	URLS_MAX: 5,
	SESSION_TTL_MIN: 60,
	SESSION_TTL_MAX: 3600,
	SESSION_ACTIVE_JOBS_MAX: 5,
	EXTERNAL_USER_MAX: 120,
	IMAGES_PAGE_MAX: 100,
} as const;

const MODES = ['prompt', 'product', 'edit', 'batch'];

function invalid(message: string, details?: Record<string, unknown>): never {
	throw new ImagineError('VALIDATION_ERROR', message, {details});
}

const isInt = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function optionalText(value: unknown, field: string, max: number): void {
	if (value === undefined || value === null) return;
	if (typeof value !== 'string') invalid(`${field} must be text`);
	if (value.length > max) invalid(`${field} must be at most ${max} characters`);
}

function optionalInt(value: unknown, field: string, min: number, max: number): void {
	if (value === undefined || value === null) return;
	if (!isInt(value, min, max)) invalid(`${field} must be a whole number from ${min} to ${max}`);
}

export function checkIdempotencyKey(key: string): void {
	if (!key.trim() || key.length > LIMITS.IDEMPOTENCY_KEY_MAX || !/^[\x21-\x7e]+$/.test(key)) {
		invalid(`idempotencyKey must be 1 to ${LIMITS.IDEMPOTENCY_KEY_MAX} visible ASCII characters`);
	}
}

export function checkCreateJob(req: CreateJobRequest): void {
	if (!req || typeof req !== 'object' || Array.isArray(req)) invalid('A job request must be an object: rows (items) or a recipe (mode).');
	const r = req as unknown as Record<string, unknown>;
	const hasRows = r.items !== undefined;
	const hasMode = r.mode !== undefined;
	if (hasRows && hasMode) invalid('Send rows (items) or a recipe (mode), not both.');
	if (!hasRows && !hasMode) invalid('Send rows (items) or a recipe (mode).');

	if (hasRows) {
		if (!Array.isArray(r.items)) invalid('items must be a list of rows');
		if (r.items.length === 0) throw new ImagineError('BATCH_EMPTY', 'items has no rows.');
		if (r.items.length > LIMITS.ROWS_MAX) {
			throw new ImagineError('TOO_MANY_LINES', `At most ${LIMITS.ROWS_MAX} rows per job; ${r.items.length} were given.`);
		}
		r.items.forEach((row: unknown, i: number) => {
			if (!row || typeof row !== 'object') invalid(`items[${i}] must be an object`, {row: i});
			const {prompt, count, externalRef} = row as Record<string, unknown>;
			if (typeof prompt !== 'string' || !prompt.trim()) throw new ImagineError('PROMPT_REQUIRED', `items[${i}] has no prompt.`, {details: {row: i}});
			if (count !== undefined && !isInt(count, 1, LIMITS.ROW_COUNT_MAX)) {
				invalid(`items[${i}].count must be a whole number from 1 to ${LIMITS.ROW_COUNT_MAX}`, {row: i});
			}
			if (externalRef !== undefined && externalRef !== null && (typeof externalRef !== 'string' || externalRef.length > LIMITS.EXTERNAL_REF_MAX)) {
				invalid(`items[${i}].externalRef must be text of at most ${LIMITS.EXTERNAL_REF_MAX} characters`, {row: i});
			}
		});
	} else if (typeof r.mode !== 'string' || !MODES.includes(r.mode)) {
		throw new ImagineError('BAD_MODE', `mode must be one of ${MODES.join(', ')}.`);
	}

	optionalText(r.name, 'name', LIMITS.NAME_MAX);
	optionalText(r.externalRef, 'externalRef', LIMITS.EXTERNAL_REF_MAX);
	if (r.keepCopy !== undefined && typeof r.keepCopy !== 'boolean') invalid('keepCopy must be true or false');
	if (r.notify !== undefined && r.notify !== null) {
		if (typeof r.notify !== 'object') invalid('notify must be an object');
		const n = r.notify as Record<string, unknown>;
		optionalInt(n.everyImages, 'notify.everyImages', 1, LIMITS.NOTIFY_IMAGES_MAX);
		optionalInt(n.everyMinutes, 'notify.everyMinutes', 1, LIMITS.NOTIFY_MINUTES_MAX);
	}
}

export function checkSession(opts: CreateSessionOptions): void {
	if (!opts || typeof opts !== 'object') invalid('Session options must be an object.');
	optionalInt(opts.ttlSeconds, 'ttlSeconds', LIMITS.SESSION_TTL_MIN, LIMITS.SESSION_TTL_MAX);
	optionalInt(opts.maxImages, 'maxImages', 1, Number.MAX_SAFE_INTEGER);
	optionalInt(opts.maxActiveJobs, 'maxActiveJobs', 1, LIMITS.SESSION_ACTIVE_JOBS_MAX);
	optionalText(opts.externalUser, 'externalUser', LIMITS.EXTERNAL_USER_MAX);
	if (opts.modes !== undefined) {
		if (!Array.isArray(opts.modes) || !opts.modes.length || opts.modes.some(m => !MODES.includes(m))) {
			invalid(`modes must be a non-empty subset of ${MODES.join(', ')}`);
		}
	}
	if (opts.origins !== undefined) {
		if (!Array.isArray(opts.origins)) invalid('origins must be a list');
		for (const o of opts.origins) {
			// Exact https://host[:port], nothing after it.
			let ok = false;
			try {
				const u = new URL(o);
				ok = u.protocol === 'https:' && u.origin === o;
			} catch { ok = false; }
			if (!ok) invalid(`'${o}' is not an origin: use exactly https://host or https://host:port`);
		}
	}
}

export function checkUrls(urls: string[]): void {
	if (!Array.isArray(urls) || urls.length === 0) invalid('Give 1 to 5 image URLs.');
	if (urls.length > LIMITS.URLS_MAX) {
		throw new ImagineError('TOO_MANY_REFERENCES', `At most ${LIMITS.URLS_MAX} URLs; ${urls.length} were given.`);
	}
	for (const url of urls) {
		let ok = false;
		try { ok = typeof url === 'string' && new URL(url).protocol === 'https:'; } catch { ok = false; }
		if (!ok) throw new ImagineError('BAD_URL', `'${String(url)}' is not an https:// URL.`);
	}
}
