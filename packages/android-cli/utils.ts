import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	keyHint,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

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
	const result = await pi.exec("android", args, {
		timeout: opts?.timeout ?? 120_000,
		signal: opts?.signal,
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		code: result.code ?? 0,
		killed: result.killed ?? false,
	};
}

export interface AndroidRunOpts {
	timeout?: number;
	signal?: AbortSignal;
	/** Status shown in the footer and as the partial tool row while the command runs. */
	status?: string;
	ctx?: ExtensionContext;
	onUpdate?: AgentToolUpdateCallback;
}

export async function runAndroid(
	pi: ExtensionAPI,
	args: string[],
	opts?: AndroidRunOpts,
): Promise<ExecResult> {
	const { status, ctx, onUpdate } = opts ?? {};
	if (status) {
		onUpdate?.({ content: [{ type: "text", text: status }], details: {} });
		if (ctx?.hasUI) {
			ctx.ui.setStatus("android", ctx.ui.theme.fg("accent", `▲ ${status}`));
		}
	}
	try {
		return await androidExec(pi, args, {
			timeout: opts?.timeout,
			signal: opts?.signal,
		});
	} finally {
		if (status && ctx?.hasUI) ctx.ui.setStatus("android", undefined);
	}
}

export function formatExecResult(result: ExecResult): string {
	const parts: string[] = [];
	if (result.stdout.trim()) parts.push(result.stdout.trim());
	if (result.stderr.trim()) parts.push(`stderr: ${result.stderr.trim()}`);
	if (result.code !== 0) parts.push(`exit code: ${result.code}`);
	const text = parts.join("\n") || "(no output)";

	const trunc = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!trunc.truncated) return text;

	// ponytail: full output to tmp so the agent can read what was cut
	const fullFile = join(tmpdir(), `android-cli-${Date.now()}.log`);
	try {
		writeFileSync(fullFile, text);
	} catch {
		// tmp write failed — notice still shows what was kept
	}
	return `${trunc.content}\n[Truncated: showing last ${trunc.outputLines} of ${trunc.totalLines} lines (${formatSize(trunc.outputBytes)} of ${formatSize(trunc.totalBytes)}). Full output: ${fullFile}]`;
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
		content: [{ type: "text" as const, text }],
		details: details ?? {},
	};
}

export function toolError(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
		isError: true,
	};
}

/** User cancel is not an error: neutral result, no isError flag. */
export function toolCancelled(text = "Cancelled by user") {
	return {
		content: [{ type: "text" as const, text }],
		details: { cancelled: true },
	};
}

// --- branded tool-row helpers ---

export type RenderTheme = {
	fg(name: string, text: string): string;
	bold(text: string): string;
};

export function rowHead(
	theme: RenderTheme,
	label: string,
	detail?: string,
): string {
	let s = theme.fg("toolTitle", theme.bold(label));
	if (detail) s += ` ${theme.fg("muted", detail)}`;
	return s;
}

function resultHead(theme: RenderTheme, ok: boolean, text: string): string {
	const mark = ok ? theme.fg("success", "✓") : theme.fg("error", "✗");
	const body = ok ? theme.fg("muted", text) : theme.fg("error", text);
	return `${mark} ${body}`;
}

export function partialRow(theme: RenderTheme, text: string): Text {
	return new Text(theme.fg("warning", `→ ${text}`), 0, 0);
}

function expandText(theme: RenderTheme, text: string): string {
	if (!text) return "";
	// TUI: styles do not carry across lines — reapply per line
	return text
		.split("\n")
		.map((line) => theme.fg("dim", line))
		.join("\n");
}

/** Standard result row: ✓/✗ status line + keybinding hint collapsed + dim full text expanded. */
export function resultRow(
	theme: RenderTheme,
	ok: boolean,
	done: string,
	result: {
		content: ReadonlyArray<{ type: string; text?: string }>;
		details?: unknown;
	},
	opts: { expanded?: boolean; hint?: boolean } = {},
): Text {
	// Cancelled runs are neutral: neither success nor error styling
	const cancelled =
		(result.details as { cancelled?: boolean } | undefined)?.cancelled === true;
	let text = cancelled
		? theme.fg("muted", "⏹ cancelled")
		: resultHead(theme, ok, done);
	if (opts.hint && !opts.expanded) {
		text += ` ${theme.fg("dim", keyHint("app.tools.expand", "to expand"))}`;
	}
	if (opts.expanded) text += `\n${expandText(theme, resultText(result))}`;
	return new Text(text, 0, 0);
}

export function resultText(result: {
	content: ReadonlyArray<{ type: string; text?: string }>;
}): string {
	return result.content
		.map((item) => (item.type === "text" ? (item.text ?? "") : ""))
		.join("\n")
		.trim();
}

/** Shorten long queries/paths for one-line rows. */
export function short(text: string, max = 48): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
