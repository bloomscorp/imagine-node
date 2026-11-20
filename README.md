# @bloomscorp/imagine-node

Drive **Imagine**, blooms.ai's AI image generation, from your Node.js backend.

You send a request for images. blooms.ai says when it will start and at what pace,
makes them at that pace on your project's Google token, delivers them (to Bloomscorp
storage or your own S3 bucket), and tells you by webhook each time a batch is ready.

- **Safe to retry.** Every job create carries an idempotency key, so a retry, a timeout
  or a restarted process never creates the same job twice.
- **Retries for you** on network errors, `429` and `5xx`, honouring `Retry-After`.
- **One error type**, `ImagineError`, with a `code` to branch on. Your key never appears
  in an error.
- **Signed webhooks**, checked in constant time, with replay protection.
- **Typed**, ESM and CommonJS, no runtime dependencies, Node 18+.
- **Server only.** It refuses to start in a browser, where the key would be exposed.
  For a web page, mint a session here and use a browser library there.

## Install

```bash
npm install @bloomscorp/imagine-node
```

## Set up

1. Ask Bloomscorp to switch on **Imagine** and **API access** for your project.
2. In **Project Settings → API keys**, create a key and tick the **`imagine`** scope.
   A key without that scope is refused. Keep the key in your server's environment,
   never in code or a browser.
3. In the portal's Imagine **🔌 API** tab, add what you need: a **destination** (your S3
   bucket) and a **webhook** (your URL). Copy the webhook secret when it is shown: it is
   shown once.

## Quick start

```ts
import {Imagine, ImagineError} from '@bloomscorp/imagine-node';

const imagine = new Imagine({apiKey: process.env.BLOOMS_API_KEY!});

const job = await imagine.jobs.create({
	items: [
		{prompt: 'Sku 123 on a white background', count: 2, externalRef: 'sku-123/white'},
		{prompt: 'Sku 124 in a sunny kitchen', externalRef: 'sku-124/life'},
	],
	style: 'studio',
	aspectRatio: '1:1',
});
// { _id, status: 'queued', pacePerMinute: 5, schedule: { startsAt, finishesAt }, estimate: { usd }, replay: false }

const done = await imagine.jobs.waitFor(job._id, {onProgress: j => console.log(j.counts)});

for await (const image of imagine.jobs.images(job._id)) {
	console.log(image.seq, image.externalRef, image.url);   // presigned for 1 hour
}
```

A job is accepted at once (`202`) and runs at the job's `pacePerMinute`. `schedule` is
an estimate, updated as the job runs. For long jobs, use webhooks instead of `waitFor`.

## Rows and recipes

`jobs.create` takes **either** rows **or** a recipe, never both.

**Rows** are one entry per prompt, each with its own count (1–50), references and your
own `externalRef`. Up to 1 000 rows; the total must fit the project's per-job limit.
Every item and image keeps its row's `externalRef`.

```ts
await imagine.jobs.create({
	items: catalogue.map(p => ({prompt: `${p.name}, ${p.colour}, on white`, count: 2, externalRef: p.sku})),
	style: 'studio',
	destinationId: '…',            // optional: deliver to your bucket
	notify: {everyImages: 50},     // optional: webhook cadence
});
```

**Recipes** are the Studio's four modes. blooms.ai expands them into items:

```ts
await imagine.jobs.create({mode: 'prompt', prompt: 'A ceramic mug on a desk', count: 4});

const refs = await imagine.references.upload([await readFile('shirt.jpg')]);
await imagine.jobs.create({
	mode: 'product', productName: 'Linen shirt', productDetails: 'Sky blue',
	shots: ['white', 'angle', 'lifestyle'], perShot: 4, referenceIds: refs.map(r => r._id),
	aspectRatio: '4:5',
});

await imagine.jobs.create({mode: 'edit', prompt: 'Make the background light grey', sourceImageId: '…', count: 3});
await imagine.jobs.create({mode: 'batch', text: 'a red mug\na blue mug\na green mug'});
```

**Fields both take:** `credentialId`, `model`, `style`, `aspectRatio`, `name` (≤ 120),
`externalRef` (≤ 200), `destinationId`, `keepCopy`, `notify { webhookId, everyImages,
everyMinutes }`. Style ids, aspect ratios and product shots come from `presets()`.

**References.** `references.upload(files)` takes 1–5 PNG, JPEG or WebP images, each at
most 10 MB, as a `Buffer`, a `Blob` or `{ data, filename, contentType }`.
`references.fromUrls(['https://…'])` has blooms.ai fetch up to 5 images instead. Both
return references whose `_id`s go in `referenceIds`.

## Following a job

```ts
await imagine.jobs.get(jobId);
await imagine.jobs.list({status: 'active', externalRef: 'catalogue-2026-11', page: 1, limit: 20});
await imagine.jobs.items(jobId, {status: 'failed'});    // per item: seq, status, errorCode, error, externalRef

const page = await imagine.jobs.imagesPage(jobId, {limit: 100});         // { images, nextCursor }
const next = await imagine.jobs.imagesPage(jobId, {after: page.nextCursor});

await imagine.jobs.pause(jobId);
await imagine.jobs.resume(jobId);
await imagine.jobs.cancel(jobId);                        // cannot be undone
await imagine.jobs.retry(jobId);                         // failed items again
await imagine.jobs.move(jobId, {credentialId: '…', model: '…'});   // to another Google token

await imagine.images.get(imageId);                       // a fresh presigned url
await imagine.images.delete(imageId);
```

`jobs.images(jobId)` pages through the images made **so far**, in `seq` order, and stops
when `nextCursor` is `null`. On a running job, keep the last cursor from `imagesPage` and
ask again later.

`jobs.waitFor(jobId, { timeoutMs, intervalMs, onProgress, signal })` polls every 5 s
(at least 1 s) and returns the job once it is `completed`, `failed` or `cancelled`. It
throws `WAIT_TIMEOUT` after `timeoutMs` (default 1 hour) and `ABORTED` when the signal
fires.

Also: `status()` (on/off, limits, usage today and this month, models with prices),
`presets()`, `credentials.list()`, `destinations.list()`, `webhooks.list()`.

## Sessions for the browser libraries

Never send your API key to a browser. Mint a short-lived **session token** on your
server and hand only that to the page. The page uses one of:

- `@bloomscorp/imagine.js` (any framework, or a `<script>` tag)
- `@bloomscorp/ngx-imagine` (Angular)
- `@bloomscorp/react-imagine` (React)

```ts
app.post('/imagine-session', requireLogin, async (req, res) => {
	const {token, expiresAt} = await imagine.sessions.create({
		maxImages: 10,                          // all jobs of this session, in total
		modes: ['prompt', 'product', 'edit'],
		origins: ['https://shop.example.com'],  // exact https://host[:port]
		externalUser: req.user.id,              // shown on the jobs, for your reporting
		ttlSeconds: 900,                        // 60–3600
		maxActiveJobs: 1,                       // 1–5
	});
	res.json({token, expiresAt});
});

await imagine.sessions.revoke(sessionId);       // end it now
```

A token can't be refreshed. When it expires, the browser library asks your endpoint for
a new one. Always set `origins`: an empty list lets any site use the token.

## Destinations and manifests

A destination is your S3 bucket, set up in the portal (an assume-role or an access key
pair) and verified there. Pass its id as `destinationId`. Images land at:

```
{prefix}{jobId}/{seq:000000}-{imageId}.{ext}
{prefix}{jobId}/manifest-{n:0000}.json        one per imagine.images.ready
```

With a destination, `keepCopy` defaults to `false`: Bloomscorp keeps only a thumbnail,
and an image's `url` is `null`. Its `destination { bucket, key }` says where it is.

Each manifest lists that batch's images with their keys, `externalRef`, size and
`sha256`. Read it from your bucket and check it:

```ts
const manifest = imagine.manifests.parse(await readFromS3(event.data.manifestKey));
for (const img of manifest.images) {
	const bytes = await readFromS3(img.key);
	// compare sha256(bytes) with img.sha256
}
imagine.manifests.key(prefix, jobId, 3);   // 'imagine/<jobId>/manifest-0003.json'
```

If your bucket refuses a write, the job pauses with `pauseReason: 'destination'` and
resumes when the destination passes Verify in the portal.

## Webhooks

blooms.ai POSTs an event to your URL:

| Event | When |
|---|---|
| `imagine.images.ready` | Every `everyImages` (default 50) or `everyMinutes` (default 30), whichever first, and once more for the rest when the job ends |
| `imagine.job.paused` | With `data.job.pauseReason` |
| `imagine.job.resumed`, `imagine.job.completed`, `imagine.job.failed`, `imagine.job.cancelled` | |
| `imagine.ping` | The portal's "Send test" |

The body is `{ id, type, createdAt, projectId, data: { job, images?, manifestKey? } }`.
Images carry ids, `seq`, `externalRef`, destination keys and presigned URLs valid for
24 hours, never bytes.

**Verify every webhook with the raw body.** The signature covers the exact bytes
blooms.ai sent. If a JSON body parser runs first, the bytes are gone and verification
fails. With Express, put `express.raw()` on the webhook route, before any `express.json()`:

```ts
app.post('/hooks/imagine', express.raw({type: 'application/json'}), (req, res) => {
	let event;
	try {
		event = imagine.webhooks.verify(req.body, req.get('Blooms-Signature'), process.env.IMAGINE_WEBHOOK_SECRET!);
	} catch (err) {
		return res.sendStatus(400);              // ImagineSignatureError: trust nothing in it
	}
	if (event.type === 'imagine.images.ready') {
		// event.data.images, event.data.manifestKey
	}
	res.sendStatus(204);                       // answer fast; do slow work after
});
```

- The header is `Blooms-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`.
  Several `v1=` values may appear while a secret is rotated; one match is enough.
- A `t` more than 5 minutes from now is refused (`toleranceSec`, default 300), so an old
  delivery can't be replayed.
- A delivery that does not get a `2xx` within 10 s is retried after 1, 5 and 30 minutes,
  2 h and 12 h. Use the event `id` to ignore one you have already handled.
- `verifyWebhook` (no client needed) and `signWebhook` (to test your own receiver) are
  exported too.

`ImagineSignatureError` codes: `SIGNATURE_MISSING`, `SIGNATURE_MALFORMED`,
`SIGNATURE_MISMATCH`, `SIGNATURE_EXPIRED`, `RAW_BODY_REQUIRED`, `SECRET_MISSING`,
`PAYLOAD_INVALID`.

## Errors

```ts
try {
	await imagine.jobs.create(request);
} catch (err) {
	if (err instanceof ImagineError) {
		err.code;            // 'TOO_MANY_ITEMS', 'NO_CREDENTIAL', 'RATE_LIMITED', …
		err.status;          // HTTP status, when there was a response
		err.retryAfter;      // seconds, when blooms.ai said when to try again
		err.idempotencyKey;  // retry the create with this to stay safe
		err.details;         // any extra fields of the error
	}
}
```

| Status | Codes | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR`, `PROMPT_REQUIRED`, `BAD_MODE`, `BAD_RATIO`, `TOO_MANY_LINES`, `TOO_MANY_REFERENCES`, `BAD_REFERENCE`, `PRODUCT_REQUIRED`, `PRODUCT_PHOTO_REQUIRED`, `SHOTS_REQUIRED`, `SOURCE_REQUIRED`, `BATCH_EMPTY`, `NO_CREDENTIAL`, `CREDENTIAL_DISABLED`, `BAD_MODEL`, `MODEL_UNREACHABLE`, `TOO_MANY_ITEMS`, `BAD_DESTINATION`, `BAD_WEBHOOK`, `BAD_URL` | The request can't be accepted as sent |
| 400 | `BROWSER_NOT_ALLOWED` | A server route was called from a browser |
| 401 | `MISSING_API_KEY`, `INVALID_API_KEY` | The key is missing, revoked or wrong |
| 403 | `API_ACCESS_DISABLED`, `KEY_SCOPE`, `IMAGINE_DISABLED`, `ENDPOINT_DISABLED` | Not allowed. `KEY_SCOPE`: tick the `imagine` scope on the key |
| 404 | `NOT_FOUND` | Not in this project |
| 409 | `TOO_MANY_JOBS`, `STORAGE_FULL`, `JOB_FINISHED`, `NOT_PAUSED`, `NOTHING_TO_RETRY`, `NOTHING_TO_MOVE`, `IDEMPOTENCY_CONFLICT`, `IDEMPOTENCY_IN_PROGRESS` | The state says no |
| 413 | `TOO_LARGE` | Body or upload too large |
| 429 | `RATE_LIMITED` | Too many requests; retried for you, thrown when retries run out |
| — | `NETWORK_FAILURE`, `TIMEOUT`, `BAD_RESPONSE` | blooms.ai could not be reached or answered oddly, after retries |
| — | `WAIT_TIMEOUT`, `ABORTED` | `jobs.waitFor` stopped |
| — | `BAD_MANIFEST` | `manifests.parse` got something that is not a manifest |

The library checks the contract's fixed limits before sending (rows, counts, notify
cadence, references, URLs, session options) and throws the server's code, with no
`status`. Limits that depend on your project are checked by blooms.ai.

## Retries and idempotency

- Network errors, timeouts, `429` and `5xx` are retried up to `maxRetries` (3) times,
  after 0.5 s, 1 s, 2 s … with up to 25% jitter, capped at 10 s. A `Retry-After` is
  waited out instead, unless it is longer than `maxRetryWaitMs` (60 s): then it is thrown
  with `retryAfter`.
- **Job creates** carry an `Idempotency-Key`: a `crypto.randomUUID()`, or yours. The
  same key and body within 24 hours returns the original job with `replay: true`. The
  same key with a different body throws `IDEMPOTENCY_CONFLICT`. While the first request
  is still being accepted, `IDEMPOTENCY_IN_PROGRESS` is retried for you.
- **Pass your own key** for anything that must run once, for example
  `catalogue-2026-11`, so even a restarted process can't create the job twice:

  ```ts
  await imagine.jobs.create(request, {idempotencyKey: 'catalogue-2026-11'});
  ```

- `idempotencyKey: false` sends no key. Then a failed create is retried only after a
  `429` (refused before anything happened), never after a `5xx` or a dropped connection.
- Reference uploads and new sessions have no idempotency key, so they are also retried
  only after a `429`. Reads, controls and deletes are always safe to retry.

## Options

```ts
new Imagine({
	apiKey,                       // required: blm_live_… or blm_test_…, with the imagine scope
	baseUrl: 'https://z.bloomscorp.com',
	timeoutMs: 15000,             // per attempt
	uploadTimeoutMs: 120000,      // per attempt, for references.upload
	maxRetries: 3,
	maxRetryWaitMs: 60000,        // a longer Retry-After is thrown, not waited out
	fetch,                        // optional: your own fetch (proxies, tests)
});
```

## Security

- Keep the API key on your server. The library refuses to run where both `window` and
  `document` exist, and it sends the key only as `Authorization: Bearer …` to `baseUrl`.
- Browsers get session tokens: short-lived, limited to the modes, image count and
  origins you choose, and revocable. Only a hash of the token is stored by blooms.ai.
- The key is removed from every error message, even if a server echoes it.
- Verify every webhook on the raw body before acting on it, and keep the webhook secret
  in your environment. Rotate it in the portal if it leaks.
- Destination credentials and webhook secrets are set in the portal and are never
  returned by the API.

## License

MIT
