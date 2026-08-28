import type {
	ExtensionAPI,
	ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export async function androidExec(
	pi: ExtensionAPI,
	args: string[],
	opts?: { timeout?: number; signal?: AbortSignal },
): Promise<ExecResult> {
	const result = await pi.exec('android', args, {
		timeout: opts?.timeout ?? 120_000,
		signal: opts?.signal,
	});
	return {
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? '',
		code: result.code ?? 0,
		killed: result.killed ?? false,
	};
}

export function formatExecResult(result: ExecResult): string {
	const parts: string[] = [];
	if (result.stdout.trim()) parts.push(result.stdout.trim());
	if (result.stderr.trim()) parts.push(`stderr: ${result.stderr.trim()}`);
	if (result.code !== 0) parts.push(`exit code: ${result.code}`);
	return parts.join('\n') || '(no output)';
}

export function tryParseJson(text: string): unknown | null {
	try {
		return JSON.parse(text.trim());
	} catch {
		return null;
	}
}

export async function confirmGate(
	ctx: ExtensionContext,
	title: string,
	message: string,
): Promise<boolean> {
	if (!ctx.hasUI) return true;
	return ctx.ui.confirm(title, message);
}

export function toolResult(text: string, details?: Record<string, unknown>) {
	return {
		content: [{ type: 'text' as const, text }],
		details: details ?? {},
	};
}

export function toolError(text: string) {
	return {
		content: [{ type: 'text' as const, text }],
		details: {},
		isError: true,
	};
}
