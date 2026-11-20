// Submit a 1 000-row job, wait for it, then read every image.
//
// Run (from this folder, after `npm run build` in the parent):
//   npm install
//   BLOOMS_API_KEY=blm_live_… npm run bulk
//
// For a real catalogue, prefer webhooks (server.mjs) to waiting: at 5 images a
// minute, 1 000 images take more than three hours. The project's per-job limit
// (maxItemsPerJob, default 200) must allow 1 000 images, or the create is refused
// with TOO_MANY_ITEMS: ask Bloomscorp to raise it.
import {Imagine, ImagineError} from '@bloomscorp/imagine-node';

const imagine = new Imagine({apiKey: process.env.BLOOMS_API_KEY});

// One row per product. Your own SKU travels with every image as externalRef.
const rows = Array.from({length: 1000}, (_, i) => {
	const sku = `sku-${String(i + 1).padStart(4, '0')}`;
	return {prompt: `Product photo of item ${sku}, a ceramic mug, on a pure white background`, externalRef: `${sku}/white`};
});

try {
	const job = await imagine.jobs.create(
		{
			items: rows,
			name: 'Catalogue · white backgrounds',
			externalRef: 'catalogue-2026-11',
			style: 'studio',
			aspectRatio: '1:1',
			// destinationId: '…',            // deliver to your S3 bucket instead
			notify: {everyImages: 100, everyMinutes: 30},
		},
		// Your own key: running this script twice never creates two jobs.
		{idempotencyKey: 'catalogue-2026-11-white'},
	);
	console.log(job.replay ? 'Already submitted:' : 'Accepted:', job._id);
	console.log(`${job.counts.total} images at ${job.pacePerMinute}/min, from ${job.schedule.startsAt} to about ${job.schedule.finishesAt}`);
	if (job.estimate.usd !== null) console.log(`≈ $${job.estimate.usd} on your Google bill`);

	const done = await imagine.jobs.waitFor(job._id, {
		timeoutMs: 6 * 60 * 60 * 1000,
		intervalMs: 60_000,
		onProgress: j => console.log(`${j.status}: ${j.counts.done}/${j.counts.total} done, ${j.counts.failed} failed`),
	});
	console.log('Finished:', done.status);

	let n = 0;
	for await (const img of imagine.jobs.images(job._id, {limit: 100})) {
		n++;
		console.log(img.seq, img.externalRef, img.url ?? `s3://${img.destination?.bucket}/${img.destination?.key}`);
	}
	console.log(`${n} images`);

	if (done.counts.failed) {
		const failed = await imagine.jobs.items(job._id, {status: 'failed', limit: 100});
		for (const item of failed.items) console.log('failed', item.seq, item.externalRef, item.errorCode, item.error);
	}
} catch (err) {
	if (err instanceof ImagineError) {
		console.error(`${err.code}${err.status ? ` (HTTP ${err.status})` : ''}: ${err.message}`);
		process.exit(1);
	}
	throw err;
}
