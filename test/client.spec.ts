import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, describe, expect, test} from 'vitest';

import {Imagine, ImagineError} from '../src';

/**
 * Against a local fake of the blooms.ai API: nothing leaves the machine.
 * Each test queues the answers the fake gives, in order.
 */

const KEY = `blm_live_${'a'.repeat(64)}`;
const API = '/api/v1/imagine';

interface Seen { method: string; path: string; headers: IncomingMessage['headers']; body: any; form?: FormData; raw: Buffer }
type Answer = { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number } | 'hang' | 'close';

let server: Server;
let base: string;
let seen: Seen[] = [];
let answers: Answer[] = [];

beforeAll(async () => {
	server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const chunks: Buffer[] = [];
		req.on('data', c => chunks.push(c));
		req.on('end', async () => {
			const raw = Buffer.concat(chunks);
			const type = String(req.headers['content-type'] ?? '');
			const entry: Seen = {method: req.method!, path: req.url!, headers: req.headers, body: undefined, raw};
			// Take the answer before any await, so answers stay in arrival order.
			const answer = answers.shift() ?? {status: 200, body: {success: true, data: {}}};
			if (type.startsWith('multipart/form-data')) entry.form = await new Response(raw, {headers: {'content-type': type}}).formData();
			else if (raw.length) entry.body = JSON.parse(raw.toString());
			seen.push(entry);
			if (answer === 'hang') return;
			if (answer === 'close') { req.socket.destroy(); return; }
			if (answer.delayMs) await new Promise(r => setTimeout(r, answer.delayMs));
			if (res.destroyed) return;
			if (answer.status === 204) { res.writeHead(204, answer.headers || {}); res.end(); return; }
			res.writeHead(answer.status, {'Content-Type': 'application/json', ...(answer.headers || {})});
			res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {}));
		});
	});
	await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));
beforeEach(() => { seen = []; answers = []; });

const waits: number[] = [];
function client(extra: Record<string, unknown> = {}): Imagine {
	const c = new Imagine({apiKey: KEY, baseUrl: base, ...extra});
	waits.length = 0;
	c._setSleep(async ms => { waits.push(ms); });
	return c;
}
const ok = (data: unknown, status = 200, headers?: Record<string, string>, extra: Record<string, unknown> = {}): Answer =>
	({status, body: {success: true, message: 'ok', data, ...extra}, headers});
const fail = (status: number, code: string, headers?: Record<string, string>, extra: Record<string, unknown> = {}): Answer =>
	({status, body: {success: false, code, message: `${code} happened`, ...extra}, headers});

const JOB_ID = '6573a1b2c3d4e5f607182931';
const job = (over: Record<string, unknown> = {}) => ({
	_id: JOB_ID, name: 'Batch · 2 images', mode: 'batch', source: 'api', status: 'queued', pauseReason: null,
	counts: {total: 2, done: 0, failed: 0, cancelled: 0}, credentialId: 'c1', model: 'gemini-3.1-flash-image',
	pacePerMinute: 5, schedule: {acceptedAt: 'a', startsAt: 'b', finishesAt: 'c'}, estimate: {usdPerImage: 0.067, usd: 0.134},
	destinationId: null, keepCopy: true, notify: {webhookId: null, everyImages: 50, everyMinutes: 30},
	externalRef: null, createdAt: 'x', startedAt: null, finishedAt: null, lastError: null, ...over,
});
const image = (seq: number) => ({_id: `img${seq}`, jobId: JOB_ID, seq, externalRef: `sku-${seq}`, url: null, destination: null});

// PNG / JPEG / WebP signatures, enough for the type check.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2]);
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9, 9]);

describe('construction', () => {
	test('a missing or malformed key is refused, without echoing it', () => {
		expect(() => new Imagine({apiKey: ''})).toThrow(ImagineError);
		try { new Imagine({apiKey: 'ims_secret-session-token'}); expect.unreachable(); } catch (e: any) {
			expect(e.code).toBe('INVALID_API_KEY');
			expect(e.message).not.toContain('secret-session-token');
		}
	});

	test('it refuses to run in a browser', () => {
		(globalThis as any).window = {};
		(globalThis as any).document = {};
		try {
			expect(() => new Imagine({apiKey: KEY})).toThrow(expect.objectContaining({code: 'BROWSER_NOT_ALLOWED'}));
		} finally {
			delete (globalThis as any).window;
			delete (globalThis as any).document;
		}
	});

	test('a test key is accepted', () => {
		expect(() => new Imagine({apiKey: `blm_test_${'b'.repeat(64)}`})).not.toThrow();
	});
});

describe('requests', () => {
	test('send the key, a User-Agent and no Origin, under /api/v1/imagine', async () => {
		answers = [ok({on: true, reason: null, models: []})];
		const status = await client().status();
		expect(status.on).toBe(true);
		const r = seen[0]!;
		expect(`${r.method} ${r.path}`).toBe(`GET ${API}/status`);
		expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(r.headers['user-agent']).toMatch(/^imagine-node\//);
		expect(r.headers.accept).toBe('application/json');
		expect(r.headers.origin).toBeUndefined();
	});

	test('every read and control hits its path', async () => {
		const c = client();
		answers = [
			ok({aspectRatios: []}), ok([{_id: 'c1'}]), ok([{_id: 'd1'}]), ok([{_id: 'w1'}]), ok(job()),
			ok(job({status: 'paused'})), ok(job()), ok(job({status: 'cancelled'})), ok(job()), ok(job()),
			ok(image(1)), {status: 204}, {status: 204},
		];
		await c.presets(); await c.credentials.list(); await c.destinations.list(); await c.webhooks.list();
		await c.jobs.get(JOB_ID); await c.jobs.pause(JOB_ID); await c.jobs.resume(JOB_ID); await c.jobs.cancel(JOB_ID);
		await c.jobs.retry(JOB_ID); await c.jobs.move(JOB_ID, {credentialId: 'c2', model: 'gemini-3-pro-image'});
		expect((await c.images.get('img1'))._id).toBe('img1');
		await expect(c.images.delete('img1')).resolves.toBeUndefined();
		await expect(c.sessions.revoke('s/1')).resolves.toBeUndefined();
		expect(seen.map(s => `${s.method} ${s.path}`)).toEqual([
			`GET ${API}/presets`,
			`GET ${API}/credentials`,
			`GET ${API}/destinations`,
			`GET ${API}/webhooks`,
			`GET ${API}/jobs/${JOB_ID}`,
			`POST ${API}/jobs/${JOB_ID}/pause`,
			`POST ${API}/jobs/${JOB_ID}/resume`,
			`POST ${API}/jobs/${JOB_ID}/cancel`,
			`POST ${API}/jobs/${JOB_ID}/retry`,
			`POST ${API}/jobs/${JOB_ID}/move`,
			`GET ${API}/images/img1`,
			`DELETE ${API}/images/img1`,
			`DELETE ${API}/sessions/s%2F1`,
		]);
		expect(seen[9]!.body).toEqual({credentialId: 'c2', model: 'gemini-3-pro-image'});
	});

	test('jobs.get also takes { job, images } and returns the job', async () => {
		answers = [ok({job: job({status: 'running'}), images: [image(0)]})];
		const j = await client().jobs.get(JOB_ID);
		expect(j).toMatchObject({_id: JOB_ID, status: 'running'});
	});

	test('jobs.list and jobs.items send their filters and return a page', async () => {
		const c = client();
		const pagination = {total: 41, page: 2, limit: 20, pages: 3};
		answers = [ok({items: [job()], pagination}), ok([{seq: 0, status: 'done'}], 200, undefined, {pagination})];
		const list = await c.jobs.list({status: 'active', externalRef: 'catalogue 2026/11', page: 2, limit: 20});
		expect(list.items).toHaveLength(1);
		expect(list.pagination).toEqual(pagination);
		expect(seen[0]!.path).toBe(`${API}/jobs?status=active&externalRef=catalogue+2026%2F11&page=2&limit=20`);
		const items = await c.jobs.items(JOB_ID, {status: 'failed', limit: 100});
		expect(items.items[0]!.status).toBe('done');
		expect(items.pagination).toEqual(pagination);
		expect(seen[1]!.path).toBe(`${API}/jobs/${JOB_ID}/items?status=failed&limit=100`);
	});

	test('a 4xx is not retried, and its code, status and extra fields come through', async () => {
		answers = [fail(409, 'TOO_MANY_JOBS', undefined, {active: 3})];
		const err = await client().jobs.get(JOB_ID).catch(e => e);
		expect(err).toBeInstanceOf(ImagineError);
		expect(err).toMatchObject({code: 'TOO_MANY_JOBS', status: 409, details: {active: 3}});
		expect(seen).toHaveLength(1);
	});

	test('a response that is not blooms.ai JSON is BAD_RESPONSE', async () => {
		answers = [{status: 404, body: '<html>Not found</html>'}];
		expect(await client().status().catch(e => e)).toMatchObject({code: 'BAD_RESPONSE', status: 404});
	});

	test('the key never appears in an error, even if the server echoes it', async () => {
		answers = [{status: 401, body: {success: false, code: 'INVALID_API_KEY', message: `Invalid key ${KEY}`}}];
		const err = await client().status().catch(e => e);
		expect(err.message).not.toContain(KEY);
		expect(err.message).toContain('blm_***');
	});
});

describe('retries', () => {
	test('5xx is retried with growing backoff, then succeeds', async () => {
		answers = [fail(503, 'BUSY'), {status: 502, body: 'Bad gateway'}, ok(job())];
		const j = await client().jobs.get(JOB_ID);
		expect(j._id).toBe(JOB_ID);
		expect(seen).toHaveLength(3);
		expect(waits).toHaveLength(2);
		expect(waits[0]).toBeGreaterThanOrEqual(500);
		expect(waits[0]).toBeLessThanOrEqual(625);
		expect(waits[1]).toBeGreaterThanOrEqual(1000);
		expect(waits[1]).toBeLessThanOrEqual(1250);
	});

	test('a 429 waits for Retry-After (seconds or a date)', async () => {
		const c = client();
		answers = [fail(429, 'RATE_LIMITED', {'Retry-After': '7'}), ok({})];
		await c.status();
		expect(waits).toEqual([7000]);
		waits.length = 0;
		answers = [fail(429, 'RATE_LIMITED', {'Retry-After': new Date(Date.now() + 20_000).toUTCString()}), ok({})];
		await c.status();
		expect(waits[0]).toBeGreaterThanOrEqual(18000);
		expect(waits[0]).toBeLessThanOrEqual(21000);
	});

	test('a Retry-After longer than the cap is thrown with retryAfter', async () => {
		answers = [fail(429, 'RATE_LIMITED', {'Retry-After': '3600'})];
		const err = await client().status().catch(e => e);
		expect(err).toMatchObject({code: 'RATE_LIMITED', status: 429, retryAfter: 3600});
		expect(waits).toEqual([]);
	});

	test('retries stop after maxRetries and the last error is thrown', async () => {
		answers = [fail(500, 'X'), fail(500, 'X'), fail(500, 'X'), fail(500, 'SERVER_ERROR')];
		const err = await client().status().catch(e => e);
		expect(err).toMatchObject({code: 'SERVER_ERROR', status: 500});
		expect(seen).toHaveLength(4);
		answers = [fail(500, 'X'), fail(500, 'Y')];
		seen = [];
		expect(await client({maxRetries: 1}).status().catch(e => e.code)).toBe('Y');
		expect(seen).toHaveLength(2);
	});

	test('a dropped connection is retried, then reported as NETWORK_FAILURE', async () => {
		answers = ['close', 'close', 'close', 'close'];
		const err = await client().jobs.get(JOB_ID).catch(e => e);
		expect(err.code).toBe('NETWORK_FAILURE');
		expect(seen).toHaveLength(4);
		expect(err.message).not.toContain(KEY);
	});

	test('a slow answer times out', async () => {
		answers = ['hang', 'hang'];
		const err = await client({timeoutMs: 100, maxRetries: 1}).status().catch(e => e);
		expect(err.code).toBe('TIMEOUT');
		expect(seen).toHaveLength(2);
	});
});

describe('jobs.create', () => {
	const rows = {items: [{prompt: 'Sku 123 on white', count: 2, externalRef: 'sku-123/white'}, {prompt: 'Sku 124 lifestyle'}], style: 'studio'};

	test('posts rows with a generated Idempotency-Key and returns the job, not replayed', async () => {
		answers = [ok(job(), 202)];
		const j = await client().jobs.create(rows);
		expect(j).toMatchObject({_id: JOB_ID, pacePerMinute: 5, replay: false});
		const r = seen[0]!;
		expect(`${r.method} ${r.path}`).toBe(`POST ${API}/jobs`);
		expect(r.headers['content-type']).toBe('application/json');
		expect(r.headers['idempotency-key']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(r.body).toEqual(rows);
	});

	test('a recipe is posted as given', async () => {
		answers = [ok(job({mode: 'product'}), 202)];
		const recipe = {mode: 'product' as const, productName: 'Linen shirt', productDetails: 'Sky blue', shots: ['white', 'angle'], perShot: 4, referenceIds: ['r1'], aspectRatio: '4:5'};
		await client().jobs.create(recipe, {idempotencyKey: 'catalogue-2026-11'});
		expect(seen[0]!.body).toEqual(recipe);
		expect(seen[0]!.headers['idempotency-key']).toBe('catalogue-2026-11');
	});

	test('a { job, pacePerMinute, schedule, estimate } answer is flattened into the job', async () => {
		const schedule = {acceptedAt: 'A', startsAt: 'S', finishesAt: 'F'};
		answers = [ok({job: job({pacePerMinute: 1}), pacePerMinute: 4, schedule, estimate: {usdPerImage: 1, usd: 2}}, 202)];
		const j = await client().jobs.create(rows);
		expect(j).toMatchObject({_id: JOB_ID, pacePerMinute: 4, schedule, estimate: {usdPerImage: 1, usd: 2}, replay: false});
	});

	test.each([
		['replay: true in data', ok({...job(), replay: true})],
		['replay: true beside data', ok(job(), 200, undefined, {replay: true})],
		['the Idempotent-Replayed header', ok(job(), 200, {'Idempotent-Replayed': 'true'})],
	])('a replay is reported (%s)', async (_label, answer) => {
		answers = [answer];
		expect((await client().jobs.create(rows)).replay).toBe(true);
	});

	test('5xx and network errors are retried with the same key', async () => {
		answers = [fail(503, 'BUSY'), 'close', ok(job(), 202)];
		const j = await client().jobs.create(rows);
		expect(j._id).toBe(JOB_ID);
		expect(seen).toHaveLength(3);
		expect(new Set(seen.map(s => s.headers['idempotency-key'])).size).toBe(1);
		for (const s of seen) expect(s.body).toEqual(rows);
	});

	test('409 IDEMPOTENCY_IN_PROGRESS is retried shortly; IDEMPOTENCY_CONFLICT is not', async () => {
		answers = [fail(409, 'IDEMPOTENCY_IN_PROGRESS'), ok(job(), 202)];
		const c = client();
		expect((await c.jobs.create(rows, {idempotencyKey: 'k1'}))._id).toBe(JOB_ID);
		expect(seen).toHaveLength(2);
		answers = [fail(409, 'IDEMPOTENCY_CONFLICT')];
		const err = await c.jobs.create(rows, {idempotencyKey: 'k1'}).catch(e => e);
		expect(err).toMatchObject({code: 'IDEMPOTENCY_CONFLICT', status: 409, idempotencyKey: 'k1'});
		expect(seen).toHaveLength(3);
	});

	test('idempotencyKey: false sends none and does not retry a 5xx or a dropped connection, only a 429', async () => {
		const c = client();
		answers = [fail(503, 'BUSY')];
		expect((await c.jobs.create(rows, {idempotencyKey: false}).catch(e => e)).code).toBe('BUSY');
		expect(seen).toHaveLength(1);
		expect(seen[0]!.headers['idempotency-key']).toBeUndefined();
		answers = ['close'];
		expect((await c.jobs.create(rows, {idempotencyKey: false}).catch(e => e)).code).toBe('NETWORK_FAILURE');
		expect(seen).toHaveLength(2);
		answers = [fail(429, 'RATE_LIMITED', {'Retry-After': '1'}), ok(job(), 202)];
		expect((await c.jobs.create(rows, {idempotencyKey: false}))._id).toBe(JOB_ID);
		expect(seen).toHaveLength(4);
	});

	const many = (n: number, extra: Record<string, unknown> = {}) => ({items: Array.from({length: n}, (_, i) => ({prompt: `p${i}`, ...extra}))});
	test.each([
		['rows and a mode together', () => ({...rows, mode: 'prompt'}), 'VALIDATION_ERROR'],
		['neither rows nor a mode', () => ({style: 'studio'}), 'VALIDATION_ERROR'],
		['no rows', () => ({items: []}), 'BATCH_EMPTY'],
		['1 001 rows', () => many(1001), 'TOO_MANY_LINES'],
		['a row without a prompt', () => ({items: [{prompt: '  '}]}), 'PROMPT_REQUIRED'],
		['a count of 51', () => many(1, {count: 51}), 'VALIDATION_ERROR'],
		['a count of 0', () => many(1, {count: 0}), 'VALIDATION_ERROR'],
		['a row externalRef over 200 characters', () => many(1, {externalRef: 'x'.repeat(201)}), 'VALIDATION_ERROR'],
		['an unknown mode', () => ({mode: 'video', prompt: 'x'}), 'BAD_MODE'],
		['a name over 120 characters', () => ({mode: 'prompt', prompt: 'x', name: 'n'.repeat(121)}), 'VALIDATION_ERROR'],
		['notify.everyImages 1001', () => ({mode: 'prompt', prompt: 'x', notify: {everyImages: 1001}}), 'VALIDATION_ERROR'],
		['notify.everyMinutes 1441', () => ({mode: 'prompt', prompt: 'x', notify: {everyMinutes: 1441}}), 'VALIDATION_ERROR'],
	])('refused before any request: %s', async (_label, make, code) => {
		const err = await client().jobs.create(make() as any).catch(e => e);
		expect(err).toBeInstanceOf(ImagineError);
		expect(err.code).toBe(code);
		expect(seen).toHaveLength(0);
	});

	test('the limits are inclusive: 1 000 rows, count 50, notify 1000 images / 1440 minutes', async () => {
		answers = [ok(job(), 202)];
		await client().jobs.create({...many(1000, {count: 50}), notify: {everyImages: 1000, everyMinutes: 1440}, name: 'n'.repeat(120)});
		expect(seen[0]!.body.items).toHaveLength(1000);
	});

	test('an idempotency key over 200 characters is refused', async () => {
		const err = await client().jobs.create(rows, {idempotencyKey: 'k'.repeat(201)}).catch(e => e);
		expect(err.code).toBe('VALIDATION_ERROR');
		expect(seen).toHaveLength(0);
	});
});

describe('images', () => {
	test('imagesPage sends after and limit (capped at 100) and returns the cursor', async () => {
		answers = [ok({images: [image(0), image(1)], nextCursor: 'c2'})];
		const page = await client().jobs.imagesPage(JOB_ID, {after: 'c1', limit: 500});
		expect(seen[0]!.path).toBe(`${API}/jobs/${JOB_ID}/images?after=c1&limit=100`);
		expect(page).toEqual({images: [image(0), image(1)], nextCursor: 'c2'});
	});

	test('jobs.images iterates every page in order until nextCursor is null', async () => {
		answers = [
			ok({images: [image(0), image(1)], nextCursor: 'c1'}),
			ok({images: [image(2)], nextCursor: 'c2'}),
			ok([image(3)], 200, undefined, {nextCursor: null}),
		];
		const got: number[] = [];
		for await (const img of client().jobs.images(JOB_ID, {limit: 2})) got.push(img.seq);
		expect(got).toEqual([0, 1, 2, 3]);
		expect(seen.map(s => s.path)).toEqual([
			`${API}/jobs/${JOB_ID}/images?limit=2`,
			`${API}/jobs/${JOB_ID}/images?after=c1&limit=2`,
			`${API}/jobs/${JOB_ID}/images?after=c2&limit=2`,
		]);
	});

	test('jobs.images stops on an empty page and can be left early', async () => {
		answers = [ok({images: [], nextCursor: 'c1'})];
		const got: unknown[] = [];
		for await (const img of client().jobs.images(JOB_ID)) got.push(img);
		expect(got).toEqual([]);
		expect(seen).toHaveLength(1);

		seen = [];
		answers = [ok({images: [image(0), image(1)], nextCursor: 'c1'})];
		for await (const img of client().jobs.images(JOB_ID)) { if (img.seq === 0) break; }
		expect(seen).toHaveLength(1);
	});
});

describe('jobs.waitFor', () => {
	test('polls until the job finishes, reporting progress', async () => {
		answers = [
			ok(job({status: 'queued'})),
			ok(job({status: 'running', counts: {total: 2, done: 1, failed: 0, cancelled: 0}})),
			ok(job({status: 'completed', counts: {total: 2, done: 2, failed: 0, cancelled: 0}})),
		];
		const progress: string[] = [];
		const done = await client().jobs.waitFor(JOB_ID, {intervalMs: 2000, onProgress: j => progress.push(`${j.status}:${j.counts.done}`)});
		expect(done.status).toBe('completed');
		expect(progress).toEqual(['queued:0', 'running:1', 'completed:2']);
		expect(waits).toEqual([2000, 2000]);
	});

	test.each(['failed', 'cancelled'])('returns a %s job instead of throwing', async status => {
		answers = [ok(job({status}))];
		expect((await client().jobs.waitFor(JOB_ID)).status).toBe(status);
	});

	test('gives up with WAIT_TIMEOUT, carrying the last job', async () => {
		answers = Array.from({length: 10}, () => ok(job({status: 'running'})));
		const err = await client().jobs.waitFor(JOB_ID, {timeoutMs: 5000, intervalMs: 2000}).catch(e => e);
		expect(err.code).toBe('WAIT_TIMEOUT');
		expect(err.details.job.status).toBe('running');
		// Polled at 0, 2 and 4 seconds; a fourth poll would be after the 5 seconds.
		expect(seen).toHaveLength(3);
		expect(waits).toEqual([2000, 2000]);
	});

	test('stops with ABORTED when its signal fires', async () => {
		const controller = new AbortController();
		answers = Array.from({length: 10}, () => ok(job({status: 'running'})));
		const c = client();
		c._setSleep(async () => { controller.abort(); });
		const err = await c.jobs.waitFor(JOB_ID, {signal: controller.signal}).catch(e => e);
		expect(err.code).toBe('ABORTED');
		expect(seen).toHaveLength(1);
	});
});

describe('references', () => {
	const fileOf = (form: FormData, i: number) => form.getAll('images')[i] as File;
	const bytesOf = async (form: FormData, i: number) => Buffer.from(await fileOf(form, i).arrayBuffer());

	test('upload sends multipart field images: Buffer, Blob and { data, filename, contentType }', async () => {
		answers = [ok([{_id: 'r1'}, {_id: 'r2'}, {_id: 'r3'}], 201)];
		const refs = await client().references.upload([
			PNG,
			new Blob([JPEG], {type: 'image/jpeg'}),
			{data: WEBP, filename: '../photos/shirt "front".webp', contentType: 'image/webp'},
		]);
		expect(refs.map(r => r._id)).toEqual(['r1', 'r2', 'r3']);
		const r = seen[0]!;
		expect(`${r.method} ${r.path}`).toBe(`POST ${API}/references`);
		expect(r.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
		expect(r.headers['idempotency-key']).toBeUndefined();
		const files = r.form!.getAll('images') as File[];
		expect(files.map(f => [f.name, f.type])).toEqual([
			['reference-1.png', 'image/png'],
			['reference-2.jpg', 'image/jpeg'],
			['shirt front.webp', 'image/webp'],
		]);
		expect((await bytesOf(r.form!, 0)).equals(PNG)).toBe(true);
		expect((await bytesOf(r.form!, 1)).equals(JPEG)).toBe(true);
		expect((await bytesOf(r.form!, 2)).equals(WEBP)).toBe(true);
	});

	test('a single file need not be in a list', async () => {
		answers = [ok([{_id: 'r1'}], 201)];
		await client().references.upload(PNG);
		expect(seen[0]!.form!.getAll('images')).toHaveLength(1);
	});

	test('an upload is retried after a 429 with the same bytes, but not after a 5xx', async () => {
		const callerBuffer = Buffer.from(PNG);
		answers = [fail(429, 'RATE_LIMITED', {'Retry-After': '2'}), ok([{_id: 'r1'}], 201)];
		const c = client();
		c._setSleep(async ms => { waits.push(ms); callerBuffer.fill(0); });
		await c.references.upload(callerBuffer);
		expect(seen).toHaveLength(2);
		expect((await bytesOf(seen[1]!.form!, 0)).equals(PNG)).toBe(true);
		answers = [fail(502, 'BAD_GATEWAY')];
		expect((await c.references.upload(PNG).catch(e => e)).code).toBe('BAD_GATEWAY');
		expect(seen).toHaveLength(3);
	});

	const MB = 1024 * 1024;
	test.each([
		['no files', () => [], 'VALIDATION_ERROR'],
		['six files', () => Array.from({length: 6}, () => PNG), 'TOO_MANY_REFERENCES'],
		['an empty file', () => [Buffer.alloc(0)], 'VALIDATION_ERROR'],
		['a file over 10 MB', () => [Buffer.concat([PNG, Buffer.alloc(10 * MB)])], 'TOO_LARGE'],
		['a Blob over 10 MB', () => [new Blob([Buffer.alloc(10 * MB + 1)], {type: 'image/png'})], 'TOO_LARGE'],
		['a GIF', () => [Buffer.from('GIF89a......')], 'BAD_REFERENCE'],
		['a declared type that is not an image', () => [{data: PNG, contentType: 'application/pdf'}], 'BAD_REFERENCE'],
		['a declared type the bytes contradict', () => [{data: JPEG, contentType: 'image/png'}], 'BAD_REFERENCE'],
		['a number', () => [42], 'VALIDATION_ERROR'],
	])('refused before any request: %s', async (_label, make, code) => {
		const err = await client().references.upload(make() as any).catch(e => e);
		expect(err).toBeInstanceOf(ImagineError);
		expect(err.code).toBe(code);
		expect(seen).toHaveLength(0);
	});

	test('exactly 10 MB and 5 files are accepted', async () => {
		answers = [ok([], 201)];
		const tenMb = Buffer.concat([PNG, Buffer.alloc(10 * MB - PNG.length)]);
		await client().references.upload([tenMb, PNG, PNG, PNG, PNG]);
		expect((seen[0]!.form!.getAll('images') as File[]).map(f => f.size)[0]).toBe(10 * MB);
	});

	test('fromUrls posts the urls; non-https and more than 5 are refused', async () => {
		answers = [ok([{_id: 'r1'}], 201)];
		const c = client();
		await c.references.fromUrls(['https://cdn.example.com/a.png']);
		expect(`${seen[0]!.method} ${seen[0]!.path}`).toBe(`POST ${API}/references/from-url`);
		expect(seen[0]!.body).toEqual({urls: ['https://cdn.example.com/a.png']});
		expect((await c.references.fromUrls(['http://cdn.example.com/a.png']).catch(e => e)).code).toBe('BAD_URL');
		expect((await c.references.fromUrls(Array(6).fill('https://x.test/a.png')).catch(e => e)).code).toBe('TOO_MANY_REFERENCES');
		expect(seen).toHaveLength(1);
	});
});

describe('sessions', () => {
	test('create posts the options and returns the token', async () => {
		const session = {sessionId: 's1', token: `ims_${'c'.repeat(64)}`, expiresAt: '2026-11-20T00:15:00Z'};
		answers = [ok(session, 201)];
		const opts = {ttlSeconds: 900, maxImages: 10, modes: ['prompt', 'edit'] as ('prompt' | 'edit')[], origins: ['https://shop.example.com', 'https://localhost:4200'], externalUser: 'customer-8812', maxActiveJobs: 1};
		expect(await client().sessions.create(opts)).toEqual(session);
		expect(`${seen[0]!.method} ${seen[0]!.path}`).toBe(`POST ${API}/sessions`);
		expect(seen[0]!.body).toEqual(opts);
	});

	test('create with no options posts {}', async () => {
		answers = [ok({sessionId: 's1', token: 't', expiresAt: 'x'}, 201)];
		await client().sessions.create();
		expect(seen[0]!.body).toEqual({});
	});

	test('a new session is not retried after a 5xx (a retry could mint two)', async () => {
		answers = [fail(503, 'BUSY')];
		expect((await client().sessions.create().catch(e => e)).code).toBe('BUSY');
		expect(seen).toHaveLength(1);
	});

	test.each([
		['ttlSeconds 59', {ttlSeconds: 59}],
		['ttlSeconds 3601', {ttlSeconds: 3601}],
		['maxActiveJobs 6', {maxActiveJobs: 6}],
		['maxImages 0', {maxImages: 0}],
		['an unknown mode', {modes: ['video']}],
		['an http origin', {origins: ['http://shop.example.com']}],
		['an origin with a path', {origins: ['https://shop.example.com/checkout']}],
		['an externalUser over 120 characters', {externalUser: 'u'.repeat(121)}],
	])('refused before any request: %s', async (_label, opts) => {
		const err = await client().sessions.create(opts as any).catch(e => e);
		expect(err.code).toBe('VALIDATION_ERROR');
		expect(seen).toHaveLength(0);
	});
});
