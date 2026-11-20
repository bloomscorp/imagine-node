// An Express app that
//   (a) mints a browser session for the front end, and
//   (b) receives Imagine webhooks and verifies them.
//
// Run (from this folder, after `npm run build` in the parent):
//   npm install
//   BLOOMS_API_KEY=blm_live_… IMAGINE_WEBHOOK_SECRET=whsec_… npm run server
import express from 'express';
import {Imagine, ImagineError, ImagineSignatureError} from '@bloomscorp/imagine-node';

const imagine = new Imagine({apiKey: process.env.BLOOMS_API_KEY});
const app = express();

// (b) Webhooks first, with the RAW body. Registered before express.json(), so the
// JSON parser never touches it: the signature covers the exact bytes sent.
const seenEvents = new Set(); // use your database in production
app.post('/hooks/imagine', express.raw({type: 'application/json', limit: '2mb'}), (req, res) => {
	let event;
	try {
		event = imagine.webhooks.verify(req.body, req.get('Blooms-Signature'), process.env.IMAGINE_WEBHOOK_SECRET);
	} catch (err) {
		if (err instanceof ImagineSignatureError) {
			console.warn('Refused a webhook:', err.code);
			return res.sendStatus(400);
		}
		throw err;
	}

	// A delivery may be retried: handle each event id once.
	if (seenEvents.has(event.id)) return res.sendStatus(204);
	seenEvents.add(event.id);

	switch (event.type) {
		case 'imagine.images.ready':
			for (const img of event.data.images) {
				console.log(`job ${event.data.job._id}: #${img.seq} ${img.externalRef ?? ''}`,
					img.destination ? `s3://${img.destination.bucket}/${img.destination.key}` : img.url);
			}
			if (event.data.manifestKey) console.log('manifest:', event.data.manifestKey);
			break;
		case 'imagine.job.paused':
			console.log(`job ${event.data.job._id} paused: ${event.data.job.pauseReason}`);
			break;
		case 'imagine.job.completed':
		case 'imagine.job.failed':
		case 'imagine.job.cancelled':
			console.log(`job ${event.data.job._id} ${event.data.job.status}`, event.data.job.counts);
			break;
		default:
			console.log('event', event.type);
	}
	// Answer within 10 seconds; queue slow work instead of doing it here.
	res.sendStatus(204);
});

app.use(express.json());

// (a) The page calls this to get a short-lived token. Put your own login check in
// front of it: whoever can call it can spend the session's images.
app.post('/imagine-session', async (req, res) => {
	const userId = req.get('X-Demo-User') || 'demo-user'; // your session's user id
	try {
		const {token, expiresAt} = await imagine.sessions.create({
			maxImages: 10,
			modes: ['prompt', 'product', 'edit'],
			origins: ['https://shop.example.com'],
			externalUser: userId,
			ttlSeconds: 900,
		});
		res.json({token, expiresAt}); // never the API key
	} catch (err) {
		if (err instanceof ImagineError) return res.status(502).json({code: err.code});
		throw err;
	}
});

app.listen(3000, () => console.log('http://localhost:3000'));
