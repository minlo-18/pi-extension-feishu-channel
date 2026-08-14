/**
 * Chat command parsing for the Feishu bridge.
 *
 * Messages that start with `/` are intercepted BEFORE they reach the LLM, so
 * `/model`, `/thinking`, `/stop`, `/new`, etc. control the Feishu-managed
 * chat session instead of being answered conversationally by the model. This
 * module is pure and dependency-free so it is easy to unit test; the effects
 * live in `bridge.ts` against the verified pi contract.
 */

/** Thinking levels pi supports (see ThinkingLevel in pi-ai). */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export interface ParsedCommand {
	name: string; // lowercase command, without leading slash
	arg: string; // trimmed remainder after the command
	raw: string;
}

/** Parse a leading-slash command. Returns null if the text isn't a command. */
export function parseCommand(text: string): ParsedCommand | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return null;
	const m = /^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/.exec(trimmed);
	if (!m) return null;
	return { name: m[1].toLowerCase(), arg: m[2].trim(), raw: trimmed };
}

export interface ModelLike {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
}

/**
 * Resolve a model from a free-text query against the available models.
 * Matches (in order): exact id, exact name (case-insensitive), then substring
 * of id or name. Returns the single match, or a disambiguation list.
 */
export function matchModel(
	query: string,
	models: ModelLike[],
): { kind: "exact"; model: ModelLike } | { kind: "ambiguous"; matches: ModelLike[] } | { kind: "none" } {
	const q = query.trim().toLowerCase();
	if (!q) return { kind: "none" };

	const byId = models.find((m) => m.id.toLowerCase() === q);
	if (byId) return { kind: "exact", model: byId };
	const byName = models.find((m) => m.name.toLowerCase() === q);
	if (byName) return { kind: "exact", model: byName };

	const subs = models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
	if (subs.length === 1) return { kind: "exact", model: subs[0] };
	if (subs.length > 1) return { kind: "ambiguous", matches: subs };
	return { kind: "none" };
}

/** Normalize a thinking-level argument to a valid level, or null. */
export function parseThinkingLevel(arg: string): ThinkingLevelName | null {
	const v = arg.trim().toLowerCase();
	return (THINKING_LEVELS as readonly string[]).includes(v) ? (v as ThinkingLevelName) : null;
}

/** Render the model list for `/model` with no/unknown argument. */
export function formatModelList(models: ModelLike[], current?: string): string {
	if (models.length === 0) return "No models are available in this session.";
	const lines = models.slice(0, 40).map((m) => {
		const mark = current && (m.id === current || m.name === current) ? "* " : "  ";
		const think = m.reasoning ? " (reasoning)" : "";
		return `${mark}${m.name}${think} - \`${m.id}\``;
	});
	const more = models.length > 40 ? `\n...and ${models.length - 40} more` : "";
	return `**Available models** (current marked with \`*\`):\n${lines.join("\n")}${more}\n\nUsage: \`/model <name or id>\``;
}

/** Render the `/help` text listing supported chat commands. */
export function formatHelp(): string {
	return [
		"**Feishu bot commands**",
		"`/help` - show this help",
		"`/status` - model, thinking level, context usage, chat session id",
		"`/model` - list models; `/model <name|id>` - switch model",
		"`/thinking` - show levels; `/thinking <level>` - set (off/minimal/low/medium/high/xhigh/max)",
		"`/stop` - stop the current reply in this chat",
		"`/new` - start a fresh session for this chat",
		"`/clear` `/reset` - aliases for `/new`",
		"",
		"Anything not starting with `/` is sent to the agent as usual.",
	].join("\n");
}
