import { parseJsonLoose } from "../store/store.js";

/** Injected HTTP transport so contract tests run offline — the same
 * pattern as the github adapter's GhRunner. */

export interface HttpRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	/** JSON-serializable body; omitted for GETs. */
	body?: unknown;
}

export interface HttpResponse {
	status: number;
	body: string;
}

export type HttpRunner = (req: HttpRequest) => Promise<HttpResponse>;

/** Allowlisted sink API hosts. Jira Cloud sites are per-tenant
 * (<site>.atlassian.net), so they match by suffix; everything else is an
 * exact host. Test runners inject their own transport and skip this. */
const ALLOWED_API_HOSTS = [
	"api.linear.app",
	"api.trello.com",
	"api.notion.com",
	"api.clickup.com",
	".atlassian.net",
];

function assertAllowedUrl(req: HttpRequest): URL {
	let url: URL;
	try {
		url = new URL(req.url);
	} catch {
		throw new Error(`Invalid URL: ${req.url}`);
	}
	if (url.protocol !== "https:") {
		throw new Error(`Refused non-https request: ${req.url}`);
	}
	const allowed = ALLOWED_API_HOSTS.some((h) =>
		h.startsWith(".") ? url.hostname.endsWith(h) : url.hostname === h,
	);
	if (!allowed) {
		throw new Error(
			`Refused request to unexpected host ${url.hostname} — sink APIs are allowlisted: ${ALLOWED_API_HOSTS.join(", ")}`,
		);
	}
	return url;
}

export const realHttpRunner: HttpRunner = async (req) => {
	// SAFETY: only allowlisted sink API hosts, https-only — assertAllowedUrl
	// rejects any config that would point requests at internal hosts, so the
	// fetch below always goes to a vetted sink API endpoint.
	const validated = assertAllowedUrl(req);
	const headers: Record<string, string> = { ...(req.headers ?? {}) };
	if (req.body !== undefined) headers["Content-Type"] = "application/json";
	const res = await fetch(validated, {
		method: req.method,
		headers,
		body: req.body === undefined ? undefined : JSON.stringify(req.body),
	});
	return { status: res.status, body: await res.text() };
};

/** Parse a JSON response body loosely (malformed → undefined). */
export function parseBody<T>(res: HttpResponse): T | undefined {
	return parseJsonLoose<T>(res.body);
}

/** Turn a non-2xx response into a plain-language error with the body
 * excerpt the platform actually sent — juniors need the real message. */
export function httpError(what: string, res: HttpResponse): Error {
	const excerpt = res.body.slice(0, 300);
	return new Error(
		`${what} failed (HTTP ${res.status}): ${excerpt || "(empty response)"}`,
	);
}
