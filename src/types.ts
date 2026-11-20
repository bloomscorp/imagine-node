/**
 * Request and response types for the Imagine server API
 * (blooms.ai documentation/imagine/api.md §4–§8, imagine.md §7).
 *
 * Ids are 24-hex strings and times are ISO 8601 UTC strings, as the API sends them.
 */

// ── Options ───────────────────────────────────────────────────────────────────

export interface ImagineOptions {
	/** A project API key with the `imagine` scope: `blm_live_…` or `blm_test_…`. */
	apiKey: string;
	/** Defaults to `https://z.bloomscorp.com`. */
	baseUrl?: string;
	/** Per attempt. Default 15 seconds. */
	timeoutMs?: number;
	/** Per attempt, for `references.upload`. Default 120 seconds. */
	uploadTimeoutMs?: number;
	/** Retries after the first attempt, for network errors, 429 and 5xx. Default 3. */
	maxRetries?: number;
	/** The longest `Retry-After` the library will wait out by itself. Default 60 seconds. */
	maxRetryWaitMs?: number;
	/** A `fetch` to use instead of the global one (tests, proxies). */
	fetch?: typeof fetch;
}

// ── Shared ────────────────────────────────────────────────────────────────────

export type JobMode = 'prompt' | 'product' | 'edit' | 'batch';
export type JobSource = 'ui' | 'api' | 'browser';
export type JobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
/** `destination` is new in phase 2: the client's bucket refused a write (api.md §7). */
export type PauseReason = 'user' | 'daily_limit' | 'monthly_limit' | 'storage' | 'credential' | 'disabled' | 'destination';
export type ItemStatus = 'queued' | 'generating' | 'done' | 'failed' | 'cancelled' | 'paused';

export interface Pagination {
	total: number;
	page: number;
	limit: number;
	pages: number;
}

/** A page of a page-numbered list (`jobs.list`, `jobs.items`). */
export interface Page<T> {
	items: T[];
	pagination: Pagination;
}

// ── Status and presets ────────────────────────────────────────────────────────

export interface ImagineLimits {
	perMinute: number;
	/** `null` = no limit. */
	perDay: number | null;
	perMonth: number | null;
	maxItemsPerJob: number;
	maxActiveJobs: number;
	maxCredentials: number;
	maxStorageBytes: number | null;
	[key: string]: unknown;
}

export interface UsagePeriod {
	images: number;
	failed: number;
	tokens: number;
	/** Estimated spend on the client's Google bill, at list price. */
	usd: number;
	resetsAt: string;
}

export interface ImagineModel {
	id: string;
	label: string;
	providers: string[];
	note?: string;
	/** Google's list price for one standard image; `null` when unknown. */
	priceUsdPerImage: number | null;
}

export interface Status {
	/** Imagine is on for this project. */
	on: boolean;
	reason: 'platform_off' | 'not_enabled' | null;
	limits: ImagineLimits;
	usage: {day: UsagePeriod; month: UsagePeriod; storageBytes: number; storedImages: number};
	/** How many Google credentials the project holds. */
	credentials: number;
	activeJobs: number;
	models: ImagineModel[];
	pricesCheckedOn: string | null;
	[key: string]: unknown;
}

export interface Presets {
	aspectRatios: Array<{id: string; label: string; hint?: string}>;
	styles: Array<{id: string; label: string; emoji?: string}>;
	productShots: Array<{id: string; label: string; emoji?: string}>;
	limits: {
		PROMPT_MAX: number;
		DETAILS_MAX: number;
		REFS_PER_ITEM: number;
		REF_MAX_BYTES: number;
		REF_MIME: string[];
		EDIT_VARIANTS_MAX: number;
		PER_SHOT_MAX: number;
		BATCH_LINES_MAX: number;
		[key: string]: unknown;
	};
}

// ── Credentials, references, destinations, webhooks ───────────────────────────

/** A Google token of the project. Never carries a secret. */
export interface Credential {
	_id: string;
	label: string;
	provider: 'gemini' | 'vertex' | (string & {});
	isDefault: boolean;
	status: 'active' | 'disabled';
	/** The client's own lower pace for this token; `null` = the project pace. */
	pacePerMinute: number | null;
	check: {ok: boolean; models: string[]};
}

/** An uploaded reference image (a product photo, an image to edit). */
export interface Reference {
	_id: string;
	name: string;
	mimeType: string;
	width: number;
	height: number;
}

/** The client's S3 bucket. Created in the portal; used here by id. */
export interface Destination {
	_id: string;
	label: string;
	bucket: string;
	region: string;
	prefix: string;
	authType: 'role' | 'keys';
	/** Only verified destinations can be used. */
	verifiedAt: string | null;
	lastError: string | null;
}

export type WebhookEventType =
	| 'imagine.images.ready'
	| 'imagine.job.paused'
	| 'imagine.job.resumed'
	| 'imagine.job.completed'
	| 'imagine.job.failed'
	| 'imagine.job.cancelled'
	| 'imagine.ping';

/** A webhook endpoint. Created in the portal; the secret is never returned. */
export interface Webhook {
	_id: string;
	url: string;
	events: WebhookEventType[];
	active: boolean;
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

export interface NotifyOptions {
	/** A webhook of the project; when left out, every active webhook subscribed to the event. */
	webhookId?: string | null;
	/** 1–1000. Default 50. */
	everyImages?: number;
	/** 1–1440. Default 30. */
	everyMinutes?: number;
}

/** Fields both request shapes take (api.md §6). */
export interface CommonJobFields {
	/** The Google token to use; default the project's default. */
	credentialId?: string;
	model?: string;
	/** A style preset id (`presets().styles`). */
	style?: string;
	/** An aspect ratio id (`presets().aspectRatios`), e.g. `1:1`, `4:5`. */
	aspectRatio?: string;
	/** ≤ 120 characters. */
	name?: string;
	/** Your own reference for the whole job, ≤ 200 characters. */
	externalRef?: string;
	/** A verified destination: images go to your bucket. */
	destinationId?: string;
	/** Keep the full image on Bloomscorp storage too. Default `true`, or `false` with a destination. */
	keepCopy?: boolean;
	notify?: NotifyOptions;
}

/** One row of a rows request: one prompt, made `count` times. */
export interface JobRow {
	prompt: string;
	/** 1–50. Default 1. */
	count?: number;
	aspectRatio?: string;
	referenceIds?: string[];
	/** Your own reference, kept on the row's items and images. */
	externalRef?: string;
}

/** Rows (api.md §6): up to 1 000 prompts, each with its own count. Runs as a `batch` job. */
export interface RowsRequest extends CommonJobFields {
	items: JobRow[];
	mode?: never;
}

/** `count` images of one prompt. */
export interface PromptRecipe extends CommonJobFields {
	mode: 'prompt';
	prompt: string;
	count?: number;
	referenceIds?: string[];
	items?: never;
}

/** Product photos: one item per shot type × `perShot`. */
export interface ProductRecipe extends CommonJobFields {
	mode: 'product';
	productName: string;
	productDetails?: string;
	/** Product shot ids (`presets().productShots`): `white`, `angle`, `lifestyle`, … */
	shots: string[];
	/** 1–10. Default 1. */
	perShot?: number;
	/** 1–5 product photos (`references.upload`). */
	referenceIds: string[];
	items?: never;
}

/** Edit an image: `count` variants (1–10) of the instruction in `prompt`. */
export interface EditRecipe extends CommonJobFields {
	mode: 'edit';
	/** The instruction. */
	prompt: string;
	/** An image of this project to edit; or give one reference in `referenceIds`. */
	sourceImageId?: string;
	referenceIds?: string[];
	count?: number;
	items?: never;
}

/** The Studio's batch: lines of text, or CSV `prompt[,aspect_ratio][,count]`. */
export interface BatchRecipe extends CommonJobFields {
	mode: 'batch';
	text: string;
	csv?: boolean;
	referenceIds?: string[];
	items?: never;
}

export type RecipeRequest = PromptRecipe | ProductRecipe | EditRecipe | BatchRecipe;

/** Either rows or a recipe, never both (api.md §6). */
export type CreateJobRequest = RowsRequest | RecipeRequest;

export interface CreateJobOptions {
	/**
	 * Makes the create safe to repeat: the same key and body returns the original job
	 * for 24 hours. One is generated when you don't pass one. Pass your own (≤ 200
	 * characters, e.g. `catalogue-2026-11`) so even a restarted process cannot create
	 * twice. `false` sends none, and then a failed create is not retried.
	 */
	idempotencyKey?: string | false;
}

export interface Job {
	_id: string;
	name: string;
	mode: JobMode;
	source: JobSource;
	status: JobStatus;
	pauseReason: PauseReason | null;
	counts: {total: number; done: number; failed: number; cancelled: number};
	credentialId: string;
	model: string;
	/** The generation pace, in images a minute. */
	pacePerMinute: number;
	/** An estimate, updated as the job runs. */
	schedule: {acceptedAt: string; startsAt: string; finishesAt: string};
	/** `null` values when the model has no price. */
	estimate: {usdPerImage: number | null; usd: number | null};
	destinationId: string | null;
	keepCopy: boolean;
	notify: {webhookId: string | null; everyImages: number; everyMinutes: number};
	externalRef: string | null;
	/** Browser jobs only. */
	sessionId?: string | null;
	externalUser?: string | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
	lastError: string | null;
}

/** What `jobs.create` returns: the job, and whether an idempotency key replayed an earlier one. */
export interface CreatedJob extends Job {
	/** True when the Idempotency-Key matched an earlier create and nothing new was queued. */
	replay: boolean;
}

export interface ListJobsOptions {
	/** `active` = queued, running or paused. */
	status?: JobStatus | 'active';
	externalRef?: string;
	page?: number;
	limit?: number;
}

export interface ListItemsOptions {
	status?: ItemStatus;
	page?: number;
	limit?: number;
}

/** The state of one unit of work (usually one image). */
export interface JobItem {
	seq: number;
	status: ItemStatus;
	errorCode: string | null;
	error: string | null;
	externalRef: string | null;
	imageIds: string[];
	[key: string]: unknown;
}

export interface MoveJobOptions {
	credentialId: string;
	/** Needed only when the new token can't reach the job's model. */
	model?: string;
}

export interface WaitForOptions {
	/** Give up (`WAIT_TIMEOUT`) after this long. Default 1 hour; `Infinity` waits for ever. */
	timeoutMs?: number;
	/** Between polls. Default 5 seconds, at least 1 second. */
	intervalMs?: number;
	/** Called with the job after every poll. */
	onProgress?: (job: Job) => void;
	/** Stops waiting (`ABORTED`). */
	signal?: AbortSignal;
}

// ── Images ────────────────────────────────────────────────────────────────────

export interface ImageDestination {
	destinationId: string;
	bucket: string;
	key: string;
}

export interface Image {
	_id: string;
	jobId: string;
	seq: number;
	externalRef: string | null;
	mimeType: string;
	bytes: number;
	width: number;
	height: number;
	prompt: string;
	model: string;
	aspectRatio: string | null;
	estUsd: number | null;
	/** Presigned, 1 hour. `null` when delivered to a destination with `keepCopy: false`. */
	url: string | null;
	thumbUrl: string | null;
	/** Where the full image was delivered, when the job had a destination. */
	destination: ImageDestination | null;
	createdAt: string;
}

export interface ImagesPage {
	/** In `seq` order. */
	images: Image[];
	/** Pass as `after` for the next page; `null` at the end of what exists so far. */
	nextCursor: string | null;
}

export interface ImagesPageOptions {
	/** A `nextCursor` from an earlier page. */
	after?: string | null;
	/** ≤ 100. */
	limit?: number;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface CreateSessionOptions {
	/** 60–3600. Default 900. */
	ttlSeconds?: number;
	/** Images all jobs of this session may request in total. Default 10. */
	maxImages?: number;
	/** Default `['prompt', 'product', 'edit']`. */
	modes?: JobMode[];
	/** Pin the token; default the project default. */
	credentialId?: string | null;
	model?: string | null;
	/** Exact `https://host[:port]` origins the browser may call from. Empty = any (not recommended). */
	origins?: string[];
	/** Your own user id, ≤ 120 characters, stored on the session's jobs. */
	externalUser?: string;
	/** 1–5. Default 1. */
	maxActiveJobs?: number;
}

export interface Session {
	sessionId: string;
	/** `ims_<64 hex>`: give it to the browser. It can't be refreshed; mint a new one. */
	token: string;
	expiresAt: string;
}

// ── Files for references.upload ───────────────────────────────────────────────

/** A reference image: raw bytes, a Blob (or File), or bytes with a name and type. */
export type ReferenceFile =
	| Buffer
	| Uint8Array
	| ArrayBuffer
	| Blob
	| {data: Buffer | Uint8Array | ArrayBuffer | Blob; filename?: string; contentType?: string};

// ── Webhooks ──────────────────────────────────────────────────────────────────

/** An image as a webhook carries it: ids and keys, presigned URLs valid 24 hours, never bytes. */
export interface WebhookImage {
	_id: string;
	jobId?: string;
	seq: number;
	externalRef: string | null;
	url: string | null;
	thumbUrl?: string | null;
	destination: ImageDestination | null;
	mimeType?: string;
	width?: number;
	height?: number;
	bytes?: number;
	[key: string]: unknown;
}

interface WebhookEventBase<T extends WebhookEventType, D> {
	/** `evt_…`: use it to ignore a delivery you have already handled. */
	id: string;
	type: T;
	createdAt: string;
	projectId: string;
	data: D;
}

export type ImagesReadyEvent = WebhookEventBase<'imagine.images.ready', {
	job: Job;
	images: WebhookImage[];
	/** The manifest written to the destination for this batch, when the job has one. */
	manifestKey?: string | null;
}>;
/** `data.job.pauseReason` says why. */
export type JobPausedEvent = WebhookEventBase<'imagine.job.paused', {job: Job}>;
export type JobResumedEvent = WebhookEventBase<'imagine.job.resumed', {job: Job}>;
export type JobCompletedEvent = WebhookEventBase<'imagine.job.completed', {job: Job}>;
export type JobFailedEvent = WebhookEventBase<'imagine.job.failed', {job: Job}>;
export type JobCancelledEvent = WebhookEventBase<'imagine.job.cancelled', {job: Job}>;
/** The portal's "Send test". */
export type PingEvent = WebhookEventBase<'imagine.ping', Record<string, unknown>>;

/** Narrow on `type`. */
export type WebhookEvent =
	| ImagesReadyEvent
	| JobPausedEvent
	| JobResumedEvent
	| JobCompletedEvent
	| JobFailedEvent
	| JobCancelledEvent
	| PingEvent;

export interface VerifyWebhookOptions {
	/** The largest allowed distance between `t` and now, in seconds. Default 300. */
	toleranceSec?: number;
	/** "Now", as Unix seconds or a Date. For tests. */
	now?: number | Date;
}

// ── Manifests ─────────────────────────────────────────────────────────────────

export interface ManifestImage {
	seq: number;
	imageId: string;
	/** The object key in your bucket. */
	key: string;
	externalRef: string | null;
	prompt: string;
	mimeType: string;
	width: number;
	height: number;
	bytes: number;
	/** Hex SHA-256 of the image bytes: check what you read from the bucket. */
	sha256: string;
}

/** `{prefix}{jobId}/manifest-{n:0000}.json`, one per `imagine.images.ready` (api.md §7). */
export interface Manifest {
	jobId: string;
	n: number;
	images: ManifestImage[];
}
