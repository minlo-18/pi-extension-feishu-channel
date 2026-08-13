/**
 * Configuration loading for the Feishu channel extension.
 *
 * Settings resolve with the following precedence (highest wins):
 *   1. CLI flags registered by the extension (e.g. `--feishu-config <path>`).
 *   2. Environment variables (FEISHU_*).
 *   3. A project-local JSON file at `<cwd>/.pi/feishu-channel.json`
 *      (only read when the project is trusted).
 *
 * This mirrors hermes-agent's `_load_settings`, adapted to pi's config
 * conventions (env + trusted project-local file), but keeps ZERO required
 * config in code: credentials are supplied by the operator.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** How the bot behaves toward messages sent by other bots. */
export type AllowBotsMode = "none" | "mentions" | "all";

/** Per-group admission policy. */
export type GroupPolicy = "open" | "allowlist" | "disabled";

export interface FeishuConfig {
	/** Feishu open-platform app id (cli_xxx). Required. */
	appId: string;
	/** Feishu open-platform app secret. Required. */
	appSecret: string;
	/** "feishu" (China) or "lark" (International). Default "feishu". */
	domain: "feishu" | "lark";

	/** In group chats, only respond when the bot is @mentioned. Default true. */
	requireMention: boolean;
	/** How to treat messages authored by other bots. Default "none". */
	allowBots: AllowBotsMode;
	/** Group admission policy. Default "open". */
	groupPolicy: GroupPolicy;
	/** When groupPolicy === "allowlist", only these chat_ids are served. */
	allowedChats: string[];
	/** When set (non-empty), only these open_ids may DM the bot. Empty = everyone. */
	allowedUsers: string[];
	/** When true, anyone may DM the bot (overrides allowedUsers). Default false. */
	allowAllUsers: boolean;

	/**
	 * Optional bot identity overrides. When absent they are auto-hydrated at
	 * connect time via /open-apis/bot/v3/info so mention-detection works.
	 */
	botOpenId?: string;
	botName?: string;

	/**
	 * Reply routing. When true, group replies are sent with `reply` (threaded
	 * onto the triggering message); when false they are sent as new messages.
	 * Default true.
	 */
	replyInGroup: boolean;

	/** Max characters per outbound Feishu message; longer replies are chunked. */
	maxMessageLength: number;

	/**
	 * Render assistant replies that look like markdown as Feishu `post`
	 * rich-text (headings/bold/lists/links/code). Falls back to plain text if
	 * the post payload is rejected. Default true.
	 */
	richText: boolean;

	/**
	 * Download inbound media (image/file/audio/video) and forward it to the
	 * agent: images become inline image content, other files are saved locally
	 * and their paths are appended to the prompt. Default true.
	 */
	forwardMedia: boolean;
	/** Directory for saved inbound files. Default: <os tmp>/pi-feishu-inbound. */
	inboundDir: string;

	/**
	 * Interactive-card tool approval. When enabled, every tool call whose name
	 * is in `approvalTools` (or "*" for all) is gated by an Approve/Deny card
	 * sent to the bound chat; the tool only runs after Approve. Default false.
	 */
	approvalEnabled: boolean;
	/** Tool names requiring approval. Use ["*"] to gate every tool. */
	approvalTools: string[];
	/** How long to wait for an approval click before auto-deciding (ms). */
	approvalTimeoutMs: number;
	/** On timeout: true = allow, false = deny. Default false (deny). */
	approvalTimeoutAllow: boolean;

	/**
	 * Stream assistant replies live into a CardKit "typewriter" card
	 * (`streaming_mode`) as the agent generates tokens, instead of sending one
	 * message on turn end. Falls back to a normal message on failure. Default true.
	 */
	streaming: boolean;
	/** Minimum ms between streaming card updates (throttle). Default 160. */
	streamingThrottleMs: number;

	/**
	 * When a reply contains code fences or tables, send it as a schema-2.0
	 * interactive card instead of a `post` message (better code/table rendering).
	 * Default true.
	 */
	staticCard: boolean;

	/**
	 * Coalesce rapid consecutive inbound text messages from the same sender in
	 * the same chat into a single agent turn. Default true.
	 */
	debounceEnabled: boolean;
	/** Debounce window in ms (quiet period before flushing merged text). Default 800. */
	debounceMs: number;

	/**
	 * Per-chat serial processing: messages from one chat run FIFO while
	 * different chats run concurrently. Default true.
	 */
	queueEnabled: boolean;
	/**
	 * Evict (not abort) a queued task from the blocking chain after this many
	 * ms so a hung turn cannot wedge a chat forever. Default 300000 (5 min).
	 */
	queueTaskTimeoutMs: number;

	/**
	 * De-duplicate inbound messages using a logical retry identity so a Feishu
	 * re-delivery with a fresh message_id is not processed twice. Default true.
	 */
	dedupEnabled: boolean;
	/** How long (ms) a processed message stays in the dedup cache. Default 86400000 (24h). */
	dedupTtlMs: number;

	/**
	 * Add a "processing" emoji reaction on the user's triggering message while
	 * the agent works, and remove it (or swap to the failure emoji) when done.
	 * This is the familiar typing/ack feedback in chat clients. Default true.
	 */
	reactEnabled: boolean;
	/** Emoji reaction shown while processing. Default "OnIt". */
	reactEmoji: string;
	/** Emoji swapped in on failure. Empty = just remove the processing one. Default "CrossMark". */
	reactFailEmoji: string;

	/**
	 * When credentials are missing, launch the QR scan-to-create/select flow
	 * (openclaw-style) instead of just disabling the channel. Default true.
	 * The QR prints to the terminal, so this only auto-runs on an interactive
	 * TTY; otherwise use the `/feishu-login` command.
	 */
	onboarding: boolean;
}

/** Result of the QR onboarding flow, ready to persist as credentials. */
export interface OnboardingResult {
	appId: string;
	appSecret: string;
	domain: "feishu" | "lark";
	/** Bot owner / scanning user open_id, used to seed the DM allowlist. */
	openId?: string;
}

const DEFAULTS = {
	domain: "feishu" as const,
	requireMention: true,
	allowBots: "none" as AllowBotsMode,
	groupPolicy: "open" as GroupPolicy,
	allowedChats: [] as string[],
	allowedUsers: [] as string[],
	allowAllUsers: false,
	replyInGroup: true,
	maxMessageLength: 8000,
	richText: true,
	forwardMedia: true,
	approvalEnabled: false,
	approvalTools: [] as string[],
	approvalTimeoutMs: 300000,
	approvalTimeoutAllow: false,
	streaming: true,
	streamingThrottleMs: 160,
	staticCard: true,
	debounceEnabled: true,
	debounceMs: 800,
	queueEnabled: true,
	queueTaskTimeoutMs: 300000,
	dedupEnabled: true,
	dedupTtlMs: 86400000,
	reactEnabled: true,
	reactEmoji: "OnIt",
	reactFailEmoji: "CrossMark",
	onboarding: true,
};

/** Local config file name under the project `.pi/` directory. */
export const CONFIG_FILE_NAME = "feishu-channel.json";

function toBool(value: unknown, fallback: boolean): boolean {
	if (value === undefined || value === null || value === "") return fallback;
	if (typeof value === "boolean") return value;
	const s = String(value).trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(s)) return true;
	if (["0", "false", "no", "off"].includes(s)) return false;
	return fallback;
}

function toInt(value: unknown, fallback: number, { min = 0 } = {}): number {
	if (value === undefined || value === null || value === "") return fallback;
	const n = Number.parseInt(String(value), 10);
	return Number.isFinite(n) && n >= min ? n : fallback;
}

/**
 * Detect leftover example placeholders (from feishu-channel.example.json) so we
 * route to onboarding instead of "connecting" with garbage. A real Feishu app
 * id is `cli_` + 16 hex chars; the example ships `cli_xxxxxxxxxxxxxxxx` /
 * `your-app-secret`.
 */
function isPlaceholderCredential(appId: string, appSecret: string): boolean {
	const id = appId.toLowerCase();
	const secret = appSecret.toLowerCase();
	if (/^cli_x+$/.test(id)) return true; // cli_xxxxxxxxxxxxxxxx
	if (id.includes("xxxx") || id === "cli_" || id === "your-app-id") return true;
	if (secret === "your-app-secret" || secret.includes("xxxx") || secret === "your-app-secret-here") return true;
	return false;
}

function toList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
	if (typeof value === "string") {
		return value
			.split(/[,\s]+/)
			.map((v) => v.trim())
			.filter(Boolean);
	}
	return [];
}

/** Read the optional project-local JSON config file (best effort). */
function readConfigFile(filePath: string): Record<string, unknown> {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

export interface LoadConfigOptions {
	cwd: string;
	/** Whether the project is trusted (gates reading the project-local file). */
	projectTrusted: boolean;
	/** Explicit config file path from a CLI flag, if provided. */
	configPathFlag?: string;
}

export interface LoadConfigResult {
	config: FeishuConfig | null;
	error?: string;
	/** True when credentials are absent but QR onboarding is enabled. */
	needsOnboarding?: boolean;
	/** Resolved domain to use for onboarding (from env/file, default feishu). */
	domain?: "feishu" | "lark";
	/** Absolute path where onboarding should persist credentials. */
	credentialsPath?: string;
}

/** Resolve the domain from env/file layers (used before full config builds). */
function resolveDomain(pick: (e: string, f: string) => unknown): "feishu" | "lark" {
	const raw = String(pick("FEISHU_DOMAIN", "domain") ?? DEFAULTS.domain)
		.trim()
		.toLowerCase();
	return raw === "lark" ? "lark" : "feishu";
}

/**
 * Resolve the effective Feishu configuration.
 *
 * When credentials are missing, returns `{ config: null, needsOnboarding }` so
 * the caller can launch the QR onboarding flow (default) or surface the error.
 */
export function loadConfig(opts: LoadConfigOptions): LoadConfigResult {
	const env = process.env;

	// File layer (lowest precedence). Only read when trusted, or when the
	// operator explicitly pointed at a file via the CLI flag.
	let fileCfg: Record<string, unknown> = {};
	let credentialsPath = path.join(opts.cwd, ".pi", CONFIG_FILE_NAME);
	if (opts.configPathFlag) {
		credentialsPath = path.resolve(opts.cwd, opts.configPathFlag);
		fileCfg = readConfigFile(credentialsPath);
	} else if (opts.projectTrusted) {
		if (fs.existsSync(credentialsPath)) fileCfg = readConfigFile(credentialsPath);
	}

	const pick = (envKey: string, fileKey: string): unknown =>
		env[envKey] !== undefined && env[envKey] !== "" ? env[envKey] : fileCfg[fileKey];

	const appId = String(pick("FEISHU_APP_ID", "appId") ?? "").trim();
	const appSecret = String(pick("FEISHU_APP_SECRET", "appSecret") ?? "").trim();

	if (!appId || !appSecret || isPlaceholderCredential(appId, appSecret)) {
		const onboarding = toBool(pick("FEISHU_ONBOARDING", "onboarding"), DEFAULTS.onboarding);
		const placeholder = Boolean(appId) && Boolean(appSecret); // present but placeholder
		return {
			config: null,
			needsOnboarding: onboarding,
			domain: resolveDomain(pick),
			credentialsPath,
			error:
				(placeholder
					? `Feishu credentials look like unfilled example placeholders in <project>/.pi/${CONFIG_FILE_NAME}. `
					: "Missing Feishu credentials. ") +
				"Set FEISHU_APP_ID and FEISHU_APP_SECRET (env) or fill the config file" +
				(onboarding ? ", or run /feishu-login to scan a QR code." : "."),
		};
	}

	const rawDomain = String(pick("FEISHU_DOMAIN", "domain") ?? DEFAULTS.domain)
		.trim()
		.toLowerCase();
	const domain = rawDomain === "lark" ? "lark" : "feishu";

	const rawAllowBots = String(pick("FEISHU_ALLOW_BOTS", "allowBots") ?? DEFAULTS.allowBots)
		.trim()
		.toLowerCase();
	const allowBots: AllowBotsMode = (["none", "mentions", "all"] as const).includes(rawAllowBots as AllowBotsMode)
		? (rawAllowBots as AllowBotsMode)
		: DEFAULTS.allowBots;

	const rawGroupPolicy = String(pick("FEISHU_GROUP_POLICY", "groupPolicy") ?? DEFAULTS.groupPolicy)
		.trim()
		.toLowerCase();
	const groupPolicy: GroupPolicy = (["open", "allowlist", "disabled"] as const).includes(rawGroupPolicy as GroupPolicy)
		? (rawGroupPolicy as GroupPolicy)
		: DEFAULTS.groupPolicy;

	const maxLenRaw = pick("FEISHU_MAX_MESSAGE_LENGTH", "maxMessageLength");
	const maxMessageLength = Number.parseInt(String(maxLenRaw ?? DEFAULTS.maxMessageLength), 10);

	const approvalTimeoutRaw = pick("FEISHU_APPROVAL_TIMEOUT_MS", "approvalTimeoutMs");
	const approvalTimeoutMs = Number.parseInt(String(approvalTimeoutRaw ?? DEFAULTS.approvalTimeoutMs), 10);

	const inboundDir =
		String(pick("FEISHU_INBOUND_DIR", "inboundDir") ?? "").trim() || path.join(os.tmpdir(), "pi-feishu-inbound");

	const config: FeishuConfig = {
		appId,
		appSecret,
		domain,
		requireMention: toBool(pick("FEISHU_REQUIRE_MENTION", "requireMention"), DEFAULTS.requireMention),
		allowBots,
		groupPolicy,
		allowedChats: toList(pick("FEISHU_ALLOWED_CHATS", "allowedChats")),
		allowedUsers: toList(pick("FEISHU_ALLOWED_USERS", "allowedUsers")),
		allowAllUsers: toBool(pick("FEISHU_ALLOW_ALL_USERS", "allowAllUsers"), DEFAULTS.allowAllUsers),
		botOpenId: (String(pick("FEISHU_BOT_OPEN_ID", "botOpenId") ?? "").trim() || undefined) as string | undefined,
		botName: (String(pick("FEISHU_BOT_NAME", "botName") ?? "").trim() || undefined) as string | undefined,
		replyInGroup: toBool(pick("FEISHU_REPLY_IN_GROUP", "replyInGroup"), DEFAULTS.replyInGroup),
		maxMessageLength: Number.isFinite(maxMessageLength) && maxMessageLength > 0 ? maxMessageLength : DEFAULTS.maxMessageLength,
		richText: toBool(pick("FEISHU_RICH_TEXT", "richText"), DEFAULTS.richText),
		forwardMedia: toBool(pick("FEISHU_FORWARD_MEDIA", "forwardMedia"), DEFAULTS.forwardMedia),
		inboundDir,
		approvalEnabled: toBool(pick("FEISHU_APPROVAL_ENABLED", "approvalEnabled"), DEFAULTS.approvalEnabled),
		approvalTools: toList(pick("FEISHU_APPROVAL_TOOLS", "approvalTools")),
		approvalTimeoutMs: Number.isFinite(approvalTimeoutMs) && approvalTimeoutMs > 0 ? approvalTimeoutMs : DEFAULTS.approvalTimeoutMs,
		approvalTimeoutAllow: toBool(pick("FEISHU_APPROVAL_TIMEOUT_ALLOW", "approvalTimeoutAllow"), DEFAULTS.approvalTimeoutAllow),
		streaming: toBool(pick("FEISHU_STREAMING", "streaming"), DEFAULTS.streaming),
		streamingThrottleMs: toInt(pick("FEISHU_STREAMING_THROTTLE_MS", "streamingThrottleMs"), DEFAULTS.streamingThrottleMs, { min: 50 }),
		staticCard: toBool(pick("FEISHU_STATIC_CARD", "staticCard"), DEFAULTS.staticCard),
		debounceEnabled: toBool(pick("FEISHU_DEBOUNCE_ENABLED", "debounceEnabled"), DEFAULTS.debounceEnabled),
		debounceMs: toInt(pick("FEISHU_DEBOUNCE_MS", "debounceMs"), DEFAULTS.debounceMs, { min: 0 }),
		queueEnabled: toBool(pick("FEISHU_QUEUE_ENABLED", "queueEnabled"), DEFAULTS.queueEnabled),
		queueTaskTimeoutMs: toInt(pick("FEISHU_QUEUE_TASK_TIMEOUT_MS", "queueTaskTimeoutMs"), DEFAULTS.queueTaskTimeoutMs, { min: 1000 }),
		dedupEnabled: toBool(pick("FEISHU_DEDUP_ENABLED", "dedupEnabled"), DEFAULTS.dedupEnabled),
		dedupTtlMs: toInt(pick("FEISHU_DEDUP_TTL_MS", "dedupTtlMs"), DEFAULTS.dedupTtlMs, { min: 1000 }),
		reactEnabled: toBool(pick("FEISHU_REACT_ENABLED", "reactEnabled"), DEFAULTS.reactEnabled),
		reactEmoji: String(pick("FEISHU_REACT_EMOJI", "reactEmoji") ?? DEFAULTS.reactEmoji).trim() || DEFAULTS.reactEmoji,
		reactFailEmoji: String(pick("FEISHU_REACT_FAIL_EMOJI", "reactFailEmoji") ?? DEFAULTS.reactFailEmoji).trim(),
		onboarding: toBool(pick("FEISHU_ONBOARDING", "onboarding"), DEFAULTS.onboarding),
	};

	return { config, domain: config.domain, credentialsPath };
}

/**
 * Persist onboarding credentials to the project-local JSON config, merging with
 * any existing file (never clobbering unrelated keys). Seeds the DM allowlist
 * with the scanning user's open_id when available. Returns the file path.
 */
export function saveCredentials(credentialsPath: string, result: OnboardingResult): string {
	let existing: Record<string, unknown> = {};
	if (fs.existsSync(credentialsPath)) existing = readConfigFile(credentialsPath);

	const merged: Record<string, unknown> = {
		...existing,
		appId: result.appId,
		appSecret: result.appSecret,
		domain: result.domain,
	};
	// Seed DM allowlist with the owner so only they can DM the fresh bot,
	// unless the operator already configured access explicitly.
	if (result.openId && !existing.allowedUsers && existing.allowAllUsers !== true) {
		merged.allowedUsers = [result.openId];
	}

	fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
	fs.writeFileSync(credentialsPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
	return credentialsPath;
}
