/**
 * Every failure is an `ImagineError`, so callers branch on `code`, never on text.
 * Server codes pass through unchanged (api.md §3: `VALIDATION_ERROR`, `TOO_MANY_JOBS`,
 * `IDEMPOTENCY_CONFLICT`, `RATE_LIMITED`, …). The library's own:
 *   INVALID_API_KEY       the key is missing or not a blooms.ai API key (checked before any call)
 *   BROWSER_NOT_ALLOWED   constructed in a browser, where the key would leak
 *   NO_FETCH              no global fetch and none passed in
 *   NETWORK_FAILURE       blooms.ai could not be reached, after the retries
 *   TIMEOUT               an attempt took longer than `timeoutMs` (`uploadTimeoutMs` for an
 *                         upload), after the retries
 *   BAD_RESPONSE          blooms.ai answered with something that is not its JSON
 *   WAIT_TIMEOUT          `jobs.waitFor` gave up before the job finished
 *   ABORTED               `jobs.waitFor` was stopped through its `signal`
 *   BAD_MANIFEST          `manifests.parse` got something that is not a manifest
 * Checked before anything is sent, with the server's codes: `VALIDATION_ERROR`,
 * `BATCH_EMPTY`, `TOO_MANY_LINES`, `TOO_MANY_REFERENCES`, `BAD_REFERENCE`, `TOO_LARGE`, `BAD_URL`.
 */
export class ImagineError extends Error {
	readonly code: string;
	/** HTTP status, when the failure came from a response. */
	readonly status?: number;
	/** Seconds to wait before trying again, when blooms.ai said so. */
	readonly retryAfter?: number;
	/** The Idempotency-Key the request carried: retry with it to stay safe. */
	readonly idempotencyKey?: string;
	/** Extra fields from the server's error body, or detail from a local check. */
	readonly details?: Record<string, unknown>;

	constructor(code: string, message: string, extra: {
		status?: number; retryAfter?: number; idempotencyKey?: string; details?: Record<string, unknown>;
	} = {}) {
		super(message);
		this.name = 'ImagineError';
		this.code = code;
		this.status = extra.status;
		this.retryAfter = extra.retryAfter;
		this.idempotencyKey = extra.idempotencyKey;
		this.details = extra.details;
	}
}

/**
 * A webhook that must not be trusted. Answer it with a 400 and do nothing else.
 *   SIGNATURE_MISSING    no `Blooms-Signature` header
 *   SIGNATURE_MALFORMED  the header has no `t=` or no well-formed `v1=`
 *   SIGNATURE_MISMATCH   no `v1` matches the body and secret (tampered, or the wrong secret)
 *   SIGNATURE_EXPIRED    `t` is further from now than `toleranceSec` (a replay)
 *   RAW_BODY_REQUIRED    the body was already parsed; pass the raw bytes (`express.raw()`)
 *   SECRET_MISSING       no webhook secret was given
 *   PAYLOAD_INVALID      signed correctly, but the body is not a JSON event
 */
export class ImagineSignatureError extends ImagineError {
	constructor(code: string, message: string) {
		super(code, message);
		this.name = 'ImagineSignatureError';
	}
}
