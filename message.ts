/**
 * Message adaptation between Feishu IM payloads and pi-agent text.
 *
 * Inbound:  Feishu `im.message.receive_v1` event  ->  NormalizedInbound
 * Outbound: assistant markdown text                ->  Feishu post/text payload
 *
 * This is the pi-flavored, TypeScript port of hermes-agent's
 * `normalize_feishu_message` + `_build_outbound_payload`. It is intentionally
 * dependency-free and pure so it is easy to unit test.
 */

/** A mention entry as delivered by Feishu inside a message event. */
export interface FeishuMention {
	key: string; // e.g. "@_user_1"
	id?: { open_id?: string; user_id?: string; union_id?: string };
	name?: string;
}

/** Kind of media referenced by an inbound message. */
export type MediaKind = "image" | "file" | "audio" | "video";

/**
 * A resource referenced by an inbound message. `image_key` resources are
 * downloaded via the image API; the rest via the message-resource API using
 * `fileKey` + the owning `messageId`.
 */
export interface MediaRef {
	kind: MediaKind;
	/** For images: the image_key. */
	imageKey?: string;
	/** For file/audio/video: the file_key. */
	fileKey?: string;
	/** Suggested file name (for non-image files). */
	fileName?: string;
}

/** Normalized inbound message the extension feeds into the agent. */
export interface NormalizedInbound {
	/** Plain text with @mention placeholders resolved to readable names. */
	text: string;
	/** Whether the bot itself was @mentioned (or @all was used). */
	mentionsBot: boolean;
	/** Original Feishu message_type (text, post, image, ...). */
	messageType: string;
	/** Media resources referenced by the message (to be downloaded). */
	media: MediaRef[];
	/** Non-fatal note when a message type could not be fully represented. */
	note?: string;
}

/**
 * Convert a Feishu message content JSON + msg_type into readable text plus a
 * list of media references to download.
 *
 * Feishu message `content` is a JSON *string*; its shape depends on msg_type.
 * We support the common conversational types and degrade gracefully.
 */
export function normalizeInbound(params: {
	messageType: string;
	content: string;
	mentions?: FeishuMention[];
	botOpenId?: string;
	botName?: string;
}): NormalizedInbound {
	const { messageType, content, mentions = [], botOpenId, botName } = params;

	const mentionsBot = mentionsSelf(mentions, botOpenId);
	let text = "";
	let note: string | undefined;
	const media: MediaRef[] = [];

	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(content ?? "{}");
	} catch {
		parsed = {};
	}

	switch (messageType) {
		case "text": {
			text = String(parsed.text ?? "");
			break;
		}
		case "post": {
			const flat = flattenPost(parsed);
			text = flat.text;
			for (const key of flat.imageKeys) media.push({ kind: "image", imageKey: key });
			break;
		}
		case "image": {
			const key = String(parsed.image_key ?? "");
			if (key) media.push({ kind: "image", imageKey: key });
			else note = "[image received but no image_key present]";
			break;
		}
		case "audio": {
			const key = String(parsed.file_key ?? "");
			if (key) media.push({ kind: "audio", fileKey: key, fileName: "voice.opus" });
			else note = "[audio received but no file_key present]";
			break;
		}
		case "media": {
			const key = String(parsed.file_key ?? "");
			const name = String(parsed.file_name ?? "video.mp4");
			if (key) media.push({ kind: "video", fileKey: key, fileName: name });
			else note = "[video received but no file_key present]";
			break;
		}
		case "file": {
			const key = String(parsed.file_key ?? "");
			const name = String(parsed.file_name ?? "file");
			if (key) media.push({ kind: "file", fileKey: key, fileName: name });
			else note = "[file received but no file_key present]";
			break;
		}
		default: {
			// Best effort: surface any obvious text field.
			text = String(parsed.text ?? "");
			if (!text) note = `[unsupported message type "${messageType}" — no text extracted]`;
		}
	}

	text = resolveMentionPlaceholders(text, mentions, botName);
	text = stripBotMentionTokens(text, botName);

	return { text: text.trim(), mentionsBot, messageType, media, note };
}

/** Whether `mentions` targets the bot (by open_id) or uses the @all literal. */
export function mentionsSelf(mentions: FeishuMention[], botOpenId?: string): boolean {
	for (const m of mentions) {
		if (m.key === "@_all") return true;
		if (botOpenId && m.id?.open_id && m.id.open_id === botOpenId) return true;
	}
	return false;
}

/**
 * Replace Feishu mention placeholders (e.g. "@_user_1") in text with the
 * mentioned person's display name so the LLM sees natural language.
 */
function resolveMentionPlaceholders(text: string, mentions: FeishuMention[], botName?: string): string {
	let out = text;
	for (const m of mentions) {
		if (!m.key) continue;
		const label = m.name ? `@${m.name}` : botName && !m.name ? `@${botName}` : "@";
		out = out.split(m.key).join(label);
	}
	return out;
}

/** Remove a leading/trailing "@BotName" token so the prompt reads cleanly. */
function stripBotMentionTokens(text: string, botName?: string): string {
	if (!botName) return text;
	const token = `@${botName}`;
	let out = text.trim();
	if (out.startsWith(token)) out = out.slice(token.length).trim();
	if (out.endsWith(token)) out = out.slice(0, -token.length).trim();
	return out;
}

/** Flatten a Feishu `post` (rich-text) payload into plain text + image keys. */
function flattenPost(parsed: Record<string, unknown>): { text: string; imageKeys: string[] } {
	// Post shape: { <locale>: { title, content: Element[][] } } OR { title, content }
	const doc = (("content" in parsed ? parsed : firstLocale(parsed)) ?? {}) as {
		title?: string;
		content?: unknown;
	};
	const lines: string[] = [];
	const imageKeys: string[] = [];
	if (doc.title) lines.push(String(doc.title));
	const rows = Array.isArray(doc.content) ? (doc.content as unknown[]) : [];
	for (const row of rows) {
		if (!Array.isArray(row)) continue;
		const parts: string[] = [];
		for (const el of row as Array<Record<string, unknown>>) {
			const tag = String(el.tag ?? "");
			if (tag === "text" || tag === "a") parts.push(String(el.text ?? ""));
			else if (tag === "at") parts.push(`@${String(el.user_name ?? el.user_id ?? "")}`);
			else if (tag === "img" && el.image_key) imageKeys.push(String(el.image_key));
		}
		lines.push(parts.join(""));
	}
	return { text: lines.join("\n"), imageKeys };
}

function firstLocale(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
	for (const key of Object.keys(parsed)) {
		const v = parsed[key];
		if (v && typeof v === "object") return v as Record<string, unknown>;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

/**
 * Split a long reply into Feishu-sized chunks, breaking on line boundaries
 * where possible so markdown/code stays coherent.
 */
export function chunkText(text: string, maxLen: number): string[] {
	if (text.length <= maxLen) return [text];
	const chunks: string[] = [];
	let remaining = text;
	while (remaining.length > maxLen) {
		let cut = remaining.lastIndexOf("\n", maxLen);
		if (cut <= 0) cut = maxLen;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut).replace(/^\n/, "");
	}
	if (remaining) chunks.push(remaining);
	return chunks;
}

/**
 * Build the outbound message payload.
 *
 * When `richText` is true and the text contains markdown-ish syntax, render it
 * as a Feishu `post` (rich text): headings/bold/italic/links/lists/code. This
 * is a pragmatic port of hermes' `_build_markdown_post_payload`. Otherwise, or
 * when the text is plain, send as `text` which never gets rejected.
 */
export function buildOutboundPayload(text: string, richText: boolean): { msgType: "text" | "post"; content: string } {
	if (richText && looksLikeMarkdown(text)) {
		const rows = renderMarkdownToPostRows(text);
		if (rows.length > 0) {
			const post = { zh_cn: { title: "", content: rows } };
			return { msgType: "post", content: JSON.stringify(post) };
		}
	}
	return { msgType: "text", content: JSON.stringify({ text }) };
}

/** Element inside a Feishu post row. */
interface PostElement {
	tag: "text" | "a";
	text: string;
	href?: string;
	style?: string[];
}

const MARKDOWN_HINT = /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+\.\s|```|>\s)|\*\*.+?\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)/;

/** Heuristic: does this text contain markdown worth rendering as rich text? */
export function looksLikeMarkdown(text: string): boolean {
	return MARKDOWN_HINT.test(text);
}

/** Render markdown text into Feishu post rows (an array of element arrays). */
export function renderMarkdownToPostRows(text: string): PostElement[][] {
	const rows: PostElement[][] = [];
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	let inCodeFence = false;

	for (const raw of lines) {
		const line = raw;
		const fenceMatch = /^\s*```/.test(line);
		if (fenceMatch) {
			inCodeFence = !inCodeFence;
			continue; // drop the fence markers themselves
		}
		if (inCodeFence) {
			// Preserve code lines verbatim as plain text (post has no code block).
			rows.push([{ tag: "text", text: line }]);
			continue;
		}
		if (line.trim() === "") {
			rows.push([{ tag: "text", text: "" }]);
			continue;
		}

		// Headings -> bold line.
		const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
		if (heading) {
			rows.push([{ tag: "text", text: heading[2], style: ["bold"] }]);
			continue;
		}

		// Unordered / ordered list items -> bullet prefix + inline parse.
		const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
		if (bullet) {
			rows.push([{ tag: "text", text: "• " }, ...parseInline(bullet[1])]);
			continue;
		}
		const ordered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
		if (ordered) {
			rows.push([{ tag: "text", text: `${ordered[1]}. ` }, ...parseInline(ordered[2])]);
			continue;
		}

		// Blockquote.
		const quote = /^\s*>\s?(.*)$/.exec(line);
		if (quote) {
			rows.push([{ tag: "text", text: "▏ " }, ...parseInline(quote[1])]);
			continue;
		}

		rows.push(parseInline(line));
	}

	return rows;
}

// Ordered so links are matched before bold/italic; code before the rest.
const INLINE_RE = /(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(`[^`]+`)|(\*[^*]+\*|_[^_]+_)/g;

/** Parse inline markdown into styled post elements. */
export function parseInline(line: string): PostElement[] {
	const out: PostElement[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	INLINE_RE.lastIndex = 0;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((m = INLINE_RE.exec(line)) !== null) {
		if (m.index > last) out.push({ tag: "text", text: line.slice(last, m.index) });
		const token = m[0];
		if (m[1]) {
			// [text](url)
			const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
			if (link) out.push({ tag: "a", text: link[1], href: link[2] });
			else out.push({ tag: "text", text: token });
		} else if (m[2]) {
			out.push({ tag: "text", text: token.slice(2, -2), style: ["bold"] });
		} else if (m[3]) {
			out.push({ tag: "text", text: token.slice(1, -1) }); // inline code -> plain
		} else if (m[4]) {
			out.push({ tag: "text", text: token.slice(1, -1), style: ["italic"] });
		}
		last = m.index + token.length;
	}
	if (last < line.length) out.push({ tag: "text", text: line.slice(last) });
	return out.length > 0 ? out : [{ tag: "text", text: line }];
}

/** Build an interactive approval card for a gated tool call. */
export function buildApprovalCard(params: {
	approvalId: string;
	toolName: string;
	summary: string;
}): string {
	const { approvalId, toolName, summary } = params;
	const card = {
		config: { wide_screen_mode: true },
		header: {
			template: "orange",
			title: { tag: "plain_text", content: `🔐 Tool approval: ${toolName}` },
		},
		elements: [
			{ tag: "div", text: { tag: "lark_md", content: summary || "_(no arguments)_" } },
			{
				tag: "action",
				actions: [
					{
						tag: "button",
						text: { tag: "plain_text", content: "✅ Approve" },
						type: "primary",
						value: { feishuApproval: approvalId, decision: "approve" },
					},
					{
						tag: "button",
						text: { tag: "plain_text", content: "⛔ Deny" },
						type: "danger",
						value: { feishuApproval: approvalId, decision: "deny" },
					},
				],
			},
		],
	};
	return JSON.stringify(card);
}

/** Build a plain interactive card that just shows resolved text (post-click swap). */
export function buildResolvedCard(text: string, template: "green" | "red" = "green"): string {
	const card = {
		config: { wide_screen_mode: true },
		elements: [{ tag: "div", text: { tag: "lark_md", content: text } }],
		header: { template, title: { tag: "plain_text", content: "Tool approval" } },
	};
	return JSON.stringify(card);
}

/** Does the text contain a fenced code block or a markdown table? */
export function hasCodeOrTable(text: string): boolean {
	if (/```/.test(text)) return true;
	// crude GFM table detection: a header row followed by a |---| separator
	return /(^|\n)\s*\|.*\|\s*\n\s*\|?[\s:|-]+\|?\s*(\n|$)/.test(text);
}

/**
 * Build a schema-2.0 interactive card that renders `text` as one markdown
 * element (better code-block / table rendering than a `post` message).
 * Used for the static-card upgrade path.
 */
export function buildStaticContentCard(text: string): string {
	const card = {
		schema: "2.0",
		config: { streaming_mode: false, wide_screen_mode: true },
		body: {
			elements: [{ tag: "markdown", element_id: "content", content: text }],
		},
	};
	return JSON.stringify(card);
}

/**
 * Build the initial schema-2.0 card JSON for a STREAMING session. The single
 * markdown element (`element_id: "content"`) is progressively filled via the
 * CardKit element-content API while `streaming_mode` is on.
 */
export function buildStreamingCard(initial: string, throttleMs: number, headerTitle?: string): string {
	const card: Record<string, unknown> = {
		schema: "2.0",
		config: {
			streaming_mode: true,
			streaming_config: { print_frequency_ms: 50, print_step: 1, print_strategy: "fast" },
			wide_screen_mode: true,
		},
		body: {
			elements: [{ tag: "markdown", element_id: "content", content: initial || " " }],
		},
	};
	if (headerTitle) {
		(card as { header?: unknown }).header = {
			template: "blue",
			title: { tag: "plain_text", content: headerTitle },
		};
	}
	// throttleMs is applied client-side; kept in signature for symmetry/logging.
	void throttleMs;
	return JSON.stringify(card);
}

/** Settings JSON to finalize a streaming card (turn streaming_mode off). */
export function buildStreamingFinalizeSettings(): string {
	return JSON.stringify({ config: { streaming_mode: false } });
}

/** Extract the concatenated assistant text from an agent message list. */
export function extractAssistantText(messages: Array<{ role?: string; content?: unknown }>): string {
	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const content = msg.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<Record<string, unknown>>) {
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("\n").trim();
}

/** Extract streaming assistant text from a single (partial) AgentMessage snapshot. */
export function extractMessageText(message: unknown): string {
	const msg = message as { role?: string; content?: unknown } | undefined;
	if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) return "";
	const parts: string[] = [];
	for (const block of msg.content as Array<Record<string, unknown>>) {
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("").trim();
}
