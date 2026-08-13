/**
 * Inbound debouncer: coalesce rapid consecutive text messages from the same
 * sender in the same chat into a single agent turn.
 *
 * Port of openclaw's inbound debouncer (`monitor.message-handler.ts`). Only
 * plain-text, non-command messages are debounced; media / commands / other
 * chats flush immediately (they carry their own semantics). On flush, the
 * merged text is joined by newlines and mentions are unioned, then handed to
 * the caller as one turn. Suppressed-but-merged messages have their dedupe
 * claims committed by the caller via the `parts` list.
 */

import type { FeishuMention } from "./message.ts";

export interface DebounceItem {
	messageId: string;
	chatId: string;
	chatType: string;
	text: string;
	mentions: FeishuMention[];
	mentionsBot: boolean;
	/** Commit the dedupe claim for this message once merged/flushed. */
	commit?: () => void;
}

export interface DebouncedTurn {
	chatId: string;
	chatType: string;
	/** The last message in the batch — used as reply target / chat binding. */
	lastMessageId: string;
	/** Newline-joined text of all merged messages. */
	text: string;
	/** Union of all mentions across the batch. */
	mentions: FeishuMention[];
	/** True if any message in the batch mentioned the bot. */
	mentionsBot: boolean;
	/** All merged items (so the caller can commit their dedupe claims). */
	parts: DebounceItem[];
}

interface Pending {
	items: DebounceItem[];
	timer: ReturnType<typeof setTimeout>;
}

export interface InboundDebouncer {
	/** Add a message to the batch for `key`; flushes after the quiet window. */
	push(key: string, item: DebounceItem): void;
	/** Flush everything immediately (e.g. on shutdown). */
	flushAll(): void;
	pendingKeys(): number;
}

function mergeMentions(items: DebounceItem[]): FeishuMention[] {
	const byKey = new Map<string, FeishuMention>();
	for (const item of items) {
		for (const m of item.mentions) {
			if (m.key && !byKey.has(m.key)) byKey.set(m.key, m);
		}
	}
	return [...byKey.values()];
}

export function createInboundDebouncer(
	windowMs: number,
	onFlush: (key: string, turn: DebouncedTurn) => void,
): InboundDebouncer {
	const pending = new Map<string, Pending>();

	function flush(key: string): void {
		const entry = pending.get(key);
		if (!entry) return;
		pending.delete(key);
		clearTimeout(entry.timer);
		const items = entry.items;
		if (items.length === 0) return;
		const last = items[items.length - 1];
		const turn: DebouncedTurn = {
			chatId: last.chatId,
			chatType: last.chatType,
			lastMessageId: last.messageId,
			text: items.map((i) => i.text).filter(Boolean).join("\n"),
			mentions: mergeMentions(items),
			mentionsBot: items.some((i) => i.mentionsBot),
			parts: items,
		};
		onFlush(key, turn);
	}

	function push(key: string, item: DebounceItem): void {
		const existing = pending.get(key);
		if (existing) {
			existing.items.push(item);
			clearTimeout(existing.timer);
			existing.timer = setTimeout(() => flush(key), windowMs);
		} else {
			const timer = setTimeout(() => flush(key), windowMs);
			pending.set(key, { items: [item], timer });
		}
	}

	function flushAll(): void {
		for (const key of [...pending.keys()]) flush(key);
	}

	return { push, flushAll, pendingKeys: () => pending.size };
}
