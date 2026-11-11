import { ProviderError } from '../types';

/** Parse a text/event-stream body into `data:` payloads (one per event). */
export async function* sseEvents(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<{ event?: string; data: string }> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buf = '';
	try {
		while (true) {
			if (signal?.aborted) return;
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let idx: number;
			while ((idx = findEventEnd(buf)) >= 0) {
				const raw = buf.slice(0, idx);
				buf = buf.slice(idx).replace(/^(\r?\n){2}/, '');
				const ev = parseEvent(raw);
				if (ev) yield ev;
			}
		}
		buf += decoder.decode();
		if (buf.trim()) {
			const ev = parseEvent(buf);
			if (ev) yield ev;
		}
	} finally {
		reader.releaseLock();
	}
}

function findEventEnd(buf: string): number {
	const a = buf.indexOf('\n\n');
	const b = buf.indexOf('\r\n\r\n');
	if (a < 0) return b;
	if (b < 0) return a;
	return Math.min(a, b);
}

function parseEvent(raw: string): { event?: string; data: string } | undefined {
	let event: string | undefined;
	const data: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (line.startsWith(':')) continue;
		if (line.startsWith('event:')) event = line.slice(6).trim();
		else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
	}
	if (!data.length) return undefined;
	return { event, data: data.join('\n') };
}

/** Newline-delimited JSON stream (Ollama). */
export async function* ndjson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncIterable<any> {
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buf = '';
	try {
		while (true) {
			if (signal?.aborted) return;
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl: number;
			while ((nl = buf.indexOf('\n')) >= 0) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line) yield JSON.parse(line);
			}
		}
		if (buf.trim()) yield JSON.parse(buf.trim());
	} finally {
		reader.releaseLock();
	}
}

export async function checkResponse(res: Response, provider: string): Promise<void> {
	if (res.ok) return;
	let detail = '';
	try {
		const text = await res.text();
		try {
			const j = JSON.parse(text);
			detail = j?.error?.message ?? j?.message ?? j?.error ?? text;
		} catch {
			detail = text;
		}
	} catch {
		/* body unreadable; status is still informative */
	}
	const retryable = res.status === 429 || res.status >= 500;
	const hint =
		res.status === 401 || res.status === 403 ? ' (check the API key for this provider)' :
		res.status === 404 ? ' (unknown model or endpoint)' :
		res.status === 429 ? ' (rate limited)' : '';
	throw new ProviderError(`${provider}: HTTP ${res.status}${hint}${detail ? ` - ${String(detail).slice(0, 400)}` : ''}`, provider, res.status, retryable);
}

export function joinUrl(base: string, path: string): string {
	return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

export function networkError(provider: string, err: unknown, url: string): ProviderError {
	const e = err as { name?: string; message?: string; cause?: { code?: string } };
	if (e?.name === 'AbortError') return new ProviderError('Request cancelled', provider);
	const code = e?.cause?.code;
	const msg = code === 'ECONNREFUSED' ? `cannot connect to ${url} - is the server running?` : e?.message ?? String(err);
	return new ProviderError(`${provider}: ${msg}`, provider, undefined, true);
}
