import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

type JsonObject = Record<string, unknown>;

const SEARCH_URL = 'https://s.jina.ai/';
const DEEP_SEARCH_URL = 'https://deepsearch.jina.ai/v1/chat/completions';
const READER_URL = 'https://r.jina.ai/';
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_ERROR_CHARS = 2_000;

function resolveApiKey(): string | undefined {
	const configured = process.env.JINA_API_KEY;
	if (configured) return configured;

	const agentDir =
		process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');
	try {
		const auth = JSON.parse(
			readFileSync(join(agentDir, 'auth.json'), 'utf8'),
		) as { jina?: { key?: string } };
		const key = auth.jina?.key;
		if (!key) return undefined;
		return key.startsWith('$') ? process.env[key.slice(1)] : key;
	} catch {
		return undefined;
	}
}

function result(text: string, isError = false) {
	return {
		content: [{ type: 'text' as const, text }],
		details: {},
		...(isError ? { isError: true } : {}),
	};
}

function formatResponse(body: string): string {
	try {
		const parsed = JSON.parse(body) as JsonObject;
		const choice = (parsed.choices as JsonObject[] | undefined)?.[0];
		const message = choice?.message;
		if (
			message &&
			typeof message === 'object' &&
			typeof (message as JsonObject).content === 'string'
		) {
			return (message as JsonObject).content as string;
		}
		return JSON.stringify(parsed, null, 2);
	} catch {
		return body;
	}
}

async function request(
	url: string,
	init: RequestInit,
	signal: AbortSignal | undefined,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
	const controller = new AbortController();
	const abort = () => controller.abort(signal?.reason);
	if (signal) {
		if (signal.aborted) abort();
		else signal.addEventListener('abort', abort, { once: true });
	}
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(url, { ...init, signal: controller.signal });
		const body = await response.text();
		if (!response.ok) {
			throw new Error(
				`Jina request failed (${response.status} ${response.statusText}): ${body.slice(0, MAX_ERROR_CHARS)}`,
			);
		}
		return body;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener('abort', abort);
	}
}

function headers(apiKey: string | undefined): HeadersInit {
	return {
		Accept: 'text/plain',
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
	};
}

export default function jinaExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: 'jina_search_web',
		label: 'Jina Web Search',
		description: 'Search the web with Jina and return source-backed results.',
		promptSnippet: 'Search current web information with Jina',
		promptGuidelines: [
			'Use for current or source-backed web research. Search several focused angles, then read only promising primary sources with jina_read_url.',
		],
		parameters: Type.Object({
			query: Type.String({ description: 'Focused web search query.' }),
			site: Type.Optional(
				Type.String({
					description:
						'Optional domain restriction, such as developer.android.com.',
				}),
			),
			maxResults: Type.Optional(
				Type.Number({
					minimum: 1,
					maximum: 20,
					description: 'Maximum results to return.',
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			if (!params.query.trim()) return result('query is required', true);
			const apiKey = resolveApiKey();
			if (!apiKey) return result('Jina search requires JINA_API_KEY.', true);

			const body: JsonObject = { q: params.query };
			if (params.site) body.site = params.site;
			if (params.maxResults) body.max_num_results = params.maxResults;

			try {
				const response = await request(
					SEARCH_URL,
					{
						method: 'POST',
						headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
						body: JSON.stringify(body),
					},
					signal,
				);
				return result(formatResponse(response));
			} catch (error) {
				return result(
					error instanceof Error ? error.message : String(error),
					true,
				);
			}
		},
	});

	pi.registerTool({
		name: 'jina_search_web_deep',
		label: 'Jina Deep Search',
		description:
			'Run Jina DeepSearch for passage-level web research and synthesis.',
		promptSnippet: 'Run deeper passage-ranked web research with Jina',
		promptGuidelines: [
			'Use when ordinary search needs broader passage-level ranking or synthesis.',
		],
		parameters: Type.Object({
			query: Type.String({
				description: 'Research question or focused deep-search query.',
			}),
		}),
		async execute(_toolCallId, params, signal) {
			if (!params.query.trim()) return result('query is required', true);
			const apiKey = resolveApiKey();
			if (!apiKey)
				return result('Jina deep search requires JINA_API_KEY.', true);

			try {
				const response = await request(
					DEEP_SEARCH_URL,
					{
						method: 'POST',
						headers: { ...headers(apiKey), 'Content-Type': 'application/json' },
						body: JSON.stringify({
							model: 'jina-deepsearch-v1',
							messages: [{ role: 'user', content: params.query }],
							stream: false,
						}),
					},
					signal,
				);
				return result(formatResponse(response));
			} catch (error) {
				return result(
					error instanceof Error ? error.message : String(error),
					true,
				);
			}
		},
	});

	pi.registerTool({
		name: 'jina_read_url',
		label: 'Jina Read URL',
		description:
			'Read and convert a web page to clean Markdown with Jina Reader.',
		promptSnippet: 'Read a promising web page with Jina',
		promptGuidelines: [
			'Use only after search identifies a promising URL. Prefer official docs, specifications, and primary sources.',
		],
		parameters: Type.Object({
			url: Type.String({ description: 'HTTP or HTTPS URL to read.' }),
			maxCharacters: Type.Optional(
				Type.Number({
					minimum: 1_000,
					maximum: 100_000,
					description: 'Maximum characters to return.',
				}),
			),
		}),
		async execute(_toolCallId, params, signal) {
			let target: URL;
			try {
				target = new URL(params.url);
				if (!['http:', 'https:'].includes(target.protocol))
					throw new Error('URL must use http or https.');
			} catch (error) {
				return result(
					error instanceof Error ? error.message : 'Invalid URL.',
					true,
				);
			}

			try {
				const response = await request(
					`${READER_URL}${target.toString()}`,
					{
						headers: {
							...headers(resolveApiKey()),
							'X-Return-Format': 'markdown',
						},
					},
					signal,
				);
				const text = params.maxCharacters
					? response.slice(0, params.maxCharacters)
					: response;
				return result(text);
			} catch (error) {
				return result(
					error instanceof Error ? error.message : String(error),
					true,
				);
			}
		},
	});

	pi.on('session_start', async (_event, ctx) => {
		ctx.ui.setStatus(
			'jina',
			resolveApiKey() ? 'Jina web tools ready' : 'Jina API key missing',
		);
	});
}
