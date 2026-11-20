import {randomUUID} from 'node:crypto';

import {ImagineError} from './error';
import {manifestKey, parseManifest} from './manifest';
import {prepareReferences, type PreparedReference} from './references';
import type {
	CreatedJob, CreateJobOptions, CreateJobRequest, CreateSessionOptions, Credential, Destination, Image,
	ImagesPage, ImagesPageOptions, ImagineOptions, Job, JobItem, ListItemsOptions, ListJobsOptions, Manifest,
	MoveJobOptions, Page, Presets, Reference, ReferenceFile, Session, Status, VerifyWebhookOptions, WaitForOptions,
	Webhook, WebhookEvent,
} from './types';
import {checkCreateJob, checkIdempotencyKey, checkSession, checkUrls, LIMITS} from './validate';
import {VERSION} from './version';
import {verifyWebhook} from './webhook';

/**
 * A thin, typed client for the Imagine server API
 * (blooms.ai documentation/imagine/api.md §4, §11.4).
 *
 * - Every job create carries an Idempotency-Key (yours, or one made here), kept the
 *   same across retries, so a retry can never create a job twice.
 * - Network errors, 429 and 5xx are retried with backoff and jitter, honouring
 *   Retry-After. A request that is not safe to repeat (a create without a key, an
 *   upload, a new session) is retried only on 429, which blooms.ai answers before
 *   doing anything.
 * - Failures throw `ImagineError` with a `code`; the key never appears in one.
 * - It refuses to run in a browser, where the key would be exposed.
 */

const DEFAULT_BASE = 'https://z.bloomscorp.com';
const API_PATH = '/api/v1/imagine';
const KEY_PATTERN = /^blm_(live|test)_[0-9a-f]{64}$/;
const FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled']);

/** `always`: safe to repeat. `rate-limit`: only a 429 is retried. */
type RetryPolicy = 'always' | 'rate-limit';

interface RequestOptions {
	method: 'GET' | 'POST' | 'DELETE';
	path: string;
	body?: unknown;
	/** Sent as multipart/form-data, rebuilt for every attempt from the same bytes. */
	files?: PreparedReference[];
	/** Per attempt; the client's `timeoutMs` when not given. */
	timeoutMs?: number;
	idempotencyKey?: string;
	query?: Record<string, string | number | null | undefined>;
	retry: RetryPolicy;
}

interface Envelope<T> {
	data: T;
	/** The whole parsed body: some fields (pagination, nextCursor, replay) may sit beside `data`. */
	body: Record<string, any>;
	headers: Headers;
	status: number;
}

/** Internal seam for tests: how the client waits between attempts and polls. */
export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Namespaces ────────────────────────────────────────────────────────────────

export interface CredentialsApi {
	/** The project's Google tokens. Never a secret. */
	list(): Promise<Credential[]>;
}

export interface ReferencesApi {
	/** Upload 1–5 PNG/JPEG/WebP images (≤ 10 MB each) to use as `referenceIds`. */
	upload(files: ReferenceFile | ReferenceFile[]): Promise<Reference[]>;
	/** Have blooms.ai fetch 1–5 `https://` image URLs. */
	fromUrls(urls: string[]): Promise<Reference[]>;
}

export interface JobsApi {
	/** Rows or a recipe. Answers at once (202) with the pace, schedule and estimate. */
	create(req: CreateJobRequest, options?: CreateJobOptions): Promise<CreatedJob>;
	get(jobId: string): Promise<Job>;
	list(options?: ListJobsOptions): Promise<Page<Job>>;
	/** Per-item state, in `seq` order. */
	items(jobId: string, options?: ListItemsOptions): Promise<Page<JobItem>>;
	/** Every image made so far, in `seq` order, fetching pages as you go. */
	images(jobId: string, options?: ImagesPageOptions): AsyncIterableIterator<Image>;
	/** One page of images; pass `nextCursor` back as `after`. */
	imagesPage(jobId: string, options?: ImagesPageOptions): Promise<ImagesPage>;
	pause(jobId: string): Promise<Job>;
	resume(jobId: string): Promise<Job>;
	/** Stops every item that has not started. Cannot be undone. */
	cancel(jobId: string): Promise<Job>;
	/** Queues the failed items again. */
	retry(jobId: string): Promise<Job>;
	/** Moves an active job to another Google token. */
	move(jobId: string, options: MoveJobOptions): Promise<Job>;
	/** Polls until the job is completed, failed or cancelled, and returns it. */
	waitFor(jobId: string, options?: WaitForOptions): Promise<Job>;
}

export interface ImagesApi {
	/** One image with a fresh presigned `url`. */
	get(imageId: string): Promise<Image>;
	/** Removes it from Bloomscorp storage. A copy delivered to your bucket is yours. */
	delete(imageId: string): Promise<void>;
}

export interface SessionsApi {
	/** Mint a short-lived browser token. Give `token` to the page, never your API key. */
	create(options?: CreateSessionOptions): Promise<Session>;
	/** End a session now. */
	revoke(sessionId: string): Promise<void>;
}

export interface DestinationsApi {
	list(): Promise<Destination[]>;
}

export interface WebhooksApi {
	list(): Promise<Webhook[]>;
	/**
	 * Checks a webhook's `Blooms-Signature` against the raw body and returns the
	 * event. Throws `ImagineSignatureError`; answer that with a 400.
	 */
	verify(rawBody: Buffer | Uint8Array | string, signatureHeader: string | string[] | null | undefined,
		secret: string, options?: VerifyWebhookOptions): WebhookEvent;
}

export interface ManifestsApi {
	/** Parses and checks a manifest read from your bucket. */
	parse(json: string | Buffer | Uint8Array | object): Manifest;
	/** `{prefix}{jobId}/manifest-{n:0000}.json` */
	key(prefix: string, jobId: string, n: number): string;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class Imagine {
	readonly credentials: CredentialsApi;
	readonly references: ReferencesApi;
	readonly jobs: JobsApi;
	readonly images: ImagesApi;
	readonly sessions: SessionsApi;
	readonly destinations: DestinationsApi;
	readonly webhooks: WebhooksApi;
	readonly manifests: ManifestsApi;

	readonly #apiKey: string;
	readonly #base: string;
	readonly #timeoutMs: number;
	readonly #uploadTimeoutMs: number;
	readonly #maxRetries: number;
	readonly #maxRetryWaitMs: number;
	readonly #fetch: typeof fetch;
	#sleep: Sleep = realSleep;

	constructor(options: ImagineOptions) {
		if (typeof (globalThis as any).window !== 'undefined' && typeof (globalThis as any).document !== 'undefined') {
			throw new ImagineError('BROWSER_NOT_ALLOWED',
				'@bloomscorp/imagine-node runs on servers only: in a browser your API key would be exposed. Mint a session with sessions.create() on your server and use @bloomscorp/imagine.js in the page.');
		}
		const key = String(options?.apiKey ?? '').trim();
		if (!KEY_PATTERN.test(key)) {
			throw new ImagineError('INVALID_API_KEY',
				'apiKey must be a blooms.ai API key (blm_live_… or blm_test_…). Create one with the imagine scope in Project Settings → API keys.');
		}
		const f = options.fetch ?? globalThis.fetch;
		if (typeof f !== 'function') {
			throw new ImagineError('NO_FETCH', 'No fetch is available. Use Node.js 18 or later, or pass `fetch` in the options.');
		}
		this.#apiKey = key;
		this.#base = String(options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
		this.#timeoutMs = options.timeoutMs ?? 15000;
		this.#uploadTimeoutMs = options.uploadTimeoutMs ?? 120000;
		this.#maxRetries = Math.max(0, options.maxRetries ?? 3);
		this.#maxRetryWaitMs = options.maxRetryWaitMs ?? 60000;
		this.#fetch = f;

		const id = (value: string, what: string) => {
			if (typeof value !== 'string' || !value.trim()) throw new ImagineError('VALIDATION_ERROR', `${what} is required`);
			return encodeURIComponent(value);
		};
		const get = <T>(path: string, query?: RequestOptions['query']) =>
			this.#request<T>({method: 'GET', path, query, retry: 'always'});
		const control = async (jobId: string, action: string, body?: unknown) =>
			unwrapJob((await this.#request<unknown>({method: 'POST', path: `/jobs/${id(jobId, 'jobId')}/${action}`, body, retry: 'always'})).data);

		this.credentials = {
			list: async () => (await get<Credential[]>('/credentials')).data,
		};

		this.references = {
			upload: async files => {
				const prepared = await prepareReferences(files);
				return listOf<Reference>((await this.#request<unknown>({
					method: 'POST', path: '/references', files: prepared, timeoutMs: this.#uploadTimeoutMs, retry: 'rate-limit',
				})).data);
			},
			fromUrls: async urls => {
				checkUrls(urls);
				return listOf<Reference>((await this.#request<unknown>({
					method: 'POST', path: '/references/from-url', body: {urls}, timeoutMs: this.#uploadTimeoutMs, retry: 'rate-limit',
				})).data);
			},
		};

		const imagesPage = async (jobId: string, opts: ImagesPageOptions = {}): Promise<ImagesPage> => {
			const limit = opts.limit === undefined ? undefined : Math.min(LIMITS.IMAGES_PAGE_MAX, Math.max(1, Math.floor(opts.limit)));
			const res = await get<unknown>(`/jobs/${id(jobId, 'jobId')}/images`, {after: opts.after ?? undefined, limit});
			const d = res.data as any;
			const images = Array.isArray(d) ? d : Array.isArray(d?.images) ? d.images : Array.isArray(d?.items) ? d.items : [];
			const next = d && !Array.isArray(d) && 'nextCursor' in d ? d.nextCursor : res.body.nextCursor;
			return {images, nextCursor: typeof next === 'string' && next ? next : null};
		};

		this.jobs = {
			create: async (req, opts = {}) => {
				checkCreateJob(req);
				let key: string | undefined;
				if (opts.idempotencyKey === false) key = undefined;
				else if (opts.idempotencyKey === undefined || opts.idempotencyKey === null) key = randomUUID();
				else { checkIdempotencyKey(opts.idempotencyKey); key = opts.idempotencyKey; }
				const res = await this.#request<unknown>({
					method: 'POST', path: '/jobs', body: req, idempotencyKey: key, retry: key ? 'always' : 'rate-limit',
				});
				const job = unwrapJob(res.data);
				const replay = res.body.replay === true || (res.data as any)?.replay === true
					|| res.headers.get('idempotent-replayed') === 'true';
				return {...job, replay};
			},
			get: async jobId => unwrapJob((await get<unknown>(`/jobs/${id(jobId, 'jobId')}`)).data),
			list: async (opts = {}) => pageOf<Job>(await get<unknown>('/jobs', {
				status: opts.status, externalRef: opts.externalRef, page: opts.page, limit: opts.limit,
			})),
			items: async (jobId, opts = {}) => pageOf<JobItem>(await get<unknown>(`/jobs/${id(jobId, 'jobId')}/items`, {
				status: opts.status, page: opts.page, limit: opts.limit,
			})),
			images: (jobId, opts = {}) => iterateImages(imagesPage, jobId, opts),
			imagesPage,
			pause: jobId => control(jobId, 'pause'),
			resume: jobId => control(jobId, 'resume'),
			cancel: jobId => control(jobId, 'cancel'),
			retry: jobId => control(jobId, 'retry'),
			move: async (jobId, opts) => {
				if (!opts || typeof opts.credentialId !== 'string' || !opts.credentialId) {
					throw new ImagineError('VALIDATION_ERROR', 'move needs a credentialId');
				}
				return control(jobId, 'move', {credentialId: opts.credentialId, ...(opts.model ? {model: opts.model} : {})});
			},
			waitFor: (jobId, opts = {}) => this.#waitFor(jobId, opts),
		};

		this.images = {
			get: async imageId => (await get<Image>(`/images/${id(imageId, 'imageId')}`)).data,
			delete: async imageId => {
				await this.#request({method: 'DELETE', path: `/images/${id(imageId, 'imageId')}`, retry: 'always'});
			},
		};

		this.sessions = {
			create: async (opts = {}) => {
				checkSession(opts);
				return (await this.#request<Session>({method: 'POST', path: '/sessions', body: opts, retry: 'rate-limit'})).data;
			},
			revoke: async sessionId => {
				await this.#request({method: 'DELETE', path: `/sessions/${id(sessionId, 'sessionId')}`, retry: 'always'});
			},
		};

		this.destinations = {list: async () => (await get<Destination[]>('/destinations')).data};

		this.webhooks = {
			list: async () => (await get<Webhook[]>('/webhooks')).data,
			verify: (rawBody, header, secret, opts) => verifyWebhook(rawBody, header, secret, opts),
		};

		this.manifests = {parse: parseManifest, key: manifestKey};
	}

	/** On/off, limits, today's and this month's usage, models with prices, active jobs. Works while Imagine is off. */
	async status(): Promise<Status> {
		return (await this.#request<Status>({method: 'GET', path: '/status', retry: 'always'})).data;
	}

	/** Aspect ratios, styles, product shots and limits. */
	async presets(): Promise<Presets> {
		return (await this.#request<Presets>({method: 'GET', path: '/presets', retry: 'always'})).data;
	}

	// ── Waiting ──────────────────────────────────────────────────────────────

	async #waitFor(jobId: string, opts: WaitForOptions): Promise<Job> {
		const timeoutMs = opts.timeoutMs ?? 60 * 60 * 1000;
		const intervalMs = Math.max(1000, opts.intervalMs ?? 5000);
		const started = Date.now();
		let waited = 0;
		for (;;) {
			if (opts.signal?.aborted) throw new ImagineError('ABORTED', 'Stopped waiting for the job.');
			const job = await this.jobs.get(jobId);
			opts.onProgress?.(job);
			if (FINISHED.has(job.status)) return job;
			// The real time passed, or the time slept (they differ only under a test clock).
			if (Math.max(Date.now() - started, waited) + intervalMs > timeoutMs) {
				throw new ImagineError('WAIT_TIMEOUT',
					`Job ${jobId} was still ${job.status} (${job.counts?.done ?? 0}/${job.counts?.total ?? 0} done) after ${Math.round(timeoutMs / 1000)} s.`,
					{details: {job}});
			}
			await this.#sleep(intervalMs);
			waited += intervalMs;
		}
	}

	// ── Transport ────────────────────────────────────────────────────────────

	/** @internal test seam */
	_setSleep(sleep: Sleep): void {
		this.#sleep = sleep;
	}

	#redact(text: string): string {
		return String(text).split(this.#apiKey).join('blm_***');
	}

	async #request<T>(req: RequestOptions): Promise<Envelope<T>> {
		const url = new URL(`${this.#base}${API_PATH}${req.path}`);
		for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));

		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.#apiKey}`,
			Accept: 'application/json',
			'User-Agent': `imagine-node/${VERSION}`,
		};
		// A multipart body sets its own Content-Type, with the boundary.
		if (req.body !== undefined && !req.files) headers['Content-Type'] = 'application/json';
		if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;
		const json = req.body === undefined ? undefined : JSON.stringify(req.body);
		const timeoutMs = req.timeoutMs ?? this.#timeoutMs;
		const safe = req.retry === 'always';

		let attempt = 0;
		for (;;) {
			let response: Response;
			try {
				const body = req.files ? buildForm(req.files) : json;
				response = await this.#fetch(url, {method: req.method, headers, body, signal: AbortSignal.timeout(timeoutMs)});
			} catch (cause) {
				const timedOut = (cause as Error)?.name === 'TimeoutError' || (cause as Error)?.name === 'AbortError';
				if (safe && attempt < this.#maxRetries) {
					await this.#sleep(this.#backoff(attempt++));
					continue;
				}
				throw new ImagineError(timedOut ? 'TIMEOUT' : 'NETWORK_FAILURE',
					this.#redact(`${timedOut ? 'blooms.ai did not answer in time' : 'could not reach blooms.ai'}: ${(cause as Error)?.message || cause}`),
					{idempotencyKey: req.idempotencyKey});
			}

			if (response.ok && response.status === 204) {
				return {data: undefined as T, body: {}, headers: response.headers, status: response.status};
			}

			let parsed: any = null;
			try { parsed = await response.json(); } catch { parsed = null; }

			if (response.ok && parsed?.success === true) {
				return {data: parsed.data as T, body: parsed, headers: response.headers, status: response.status};
			}

			const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
			const waitMs = retryAfter === undefined ? null : retryAfter * 1000;
			const code: string | undefined = typeof parsed?.code === 'string' ? parsed.code : undefined;
			const retriable = response.status === 429
				|| (safe && response.status >= 500 && response.status !== 501)
				// "While the first is still being accepted … retry shortly" (api.md §3).
				|| (safe && response.status === 409 && code === 'IDEMPOTENCY_IN_PROGRESS' && !!req.idempotencyKey);
			if (retriable && attempt < this.#maxRetries && (waitMs === null || waitMs <= this.#maxRetryWaitMs)) {
				await this.#sleep(waitMs ?? this.#backoff(attempt));
				attempt++;
				continue;
			}

			if (!parsed || typeof parsed !== 'object') {
				throw new ImagineError('BAD_RESPONSE', `blooms.ai answered HTTP ${response.status} without its usual JSON`,
					{status: response.status, retryAfter, idempotencyKey: req.idempotencyKey});
			}
			const {success, code: _code, message, data, ...rest} = parsed;
			throw new ImagineError(code || `HTTP_${response.status}`, this.#redact(message || `request failed (HTTP ${response.status})`), {
				status: response.status,
				retryAfter,
				idempotencyKey: req.idempotencyKey,
				details: Object.keys(rest).length ? rest : undefined,
			});
		}
	}

	/** 0.5 s, 1 s, 2 s, 4 s … with up to 25% jitter, capped at 10 s. */
	#backoff(attempt: number): number {
		const base = Math.min(10000, 500 * 2 ** attempt);
		return Math.round(base * (1 + Math.random() * 0.25));
	}
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Seconds, from `Retry-After: <seconds>` or `Retry-After: <HTTP date>`. */
function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds;
	const at = Date.parse(value);
	if (Number.isFinite(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));
	return undefined;
}

/** The job, whether `data` is the job itself or `{ job, … }` with the schedule beside it. */
function unwrapJob(data: unknown): Job {
	const d = data as any;
	if (d && typeof d === 'object' && !('_id' in d) && d.job && typeof d.job === 'object') {
		const out = {...d.job};
		for (const k of ['pacePerMinute', 'schedule', 'estimate']) if (d[k] !== undefined) out[k] = d[k];
		return out as Job;
	}
	return d as Job;
}

function listOf<T>(data: unknown): T[] {
	const d = data as any;
	if (Array.isArray(d)) return d;
	for (const k of ['references', 'items']) if (Array.isArray(d?.[k])) return d[k];
	return [];
}

/** `{ items, pagination }` inside `data`, or a list in `data` with `pagination` beside it. */
function pageOf<T>(res: Envelope<unknown>): Page<T> {
	const d = res.data as any;
	const items: T[] = Array.isArray(d) ? d : Array.isArray(d?.items) ? d.items : [];
	const pagination = (!Array.isArray(d) && d?.pagination) || res.body.pagination
		|| {total: items.length, page: 1, limit: items.length, pages: 1};
	return {items, pagination};
}

async function* iterateImages(
	page: (jobId: string, opts: ImagesPageOptions) => Promise<ImagesPage>, jobId: string, opts: ImagesPageOptions,
): AsyncIterableIterator<Image> {
	let after = opts.after ?? null;
	const seen = new Set<string>();
	for (;;) {
		const {images, nextCursor} = await page(jobId, {after, limit: opts.limit});
		for (const img of images) yield img;
		// The end of what exists so far; or a cursor that would loop.
		if (!nextCursor || seen.has(nextCursor) || images.length === 0) return;
		seen.add(nextCursor);
		after = nextCursor;
	}
}

/** A fresh multipart body for one attempt; every attempt carries the same bytes. */
function buildForm(files: PreparedReference[]): FormData {
	const form = new FormData();
	for (const file of files) form.append('images', new Blob([file.bytes], {type: file.contentType}), file.filename);
	return form;
}
