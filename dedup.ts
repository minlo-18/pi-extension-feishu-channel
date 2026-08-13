/**
 * Inbound message de-duplication with a logical retry identity.
 *
 * Feishu can re-deliver the *same logical message* with a FRESH `message_id`
 * (openclaw references issue #46778). A naive `message_id`/`event_id` set does
 * not catch this, so a WebSocket reconnect / 3s-timeout re-push can make the
 * bot answer the same user text twice.
 *
 * The fix (port of openclaw `resolveFeishuMessageDedupeKey`): key text messages
 * on a *retry identity* — `sender + chat + create_time + sha256(content)` —
 * where `create_time` is the server's fixed authoring timestamp, so a genuine
 * re-send by the user (new create_time) stays distinct while a transport
 * redelivery (same create_time) collapses. Media keys on message_id + resource
 * key. Falls back to message_id when fields are missing.
 *
 * A claim protocol (`claim` -> `commit` / `release`) gives exclusive handling
 * plus in-flight detection, not just after-the-fact dedup. In-memory only
 * (single pi process); entries expire after `ttlMs`.
 */

import { createHash } from "node:crypto";

export interface DedupeInput {
	messageId: string;
	chatId: string;
	senderOpenId?: string;
	messageType: string;
	/** Raw Feishu message content JSON string. */
	content: string;
	/** Server authoring timestamp (ms epoch as string). */
	createTime?: string;
}

export type ClaimResult =
	| { kind: "claimed"; key: string; commit: () => void; release: () => void }
	| { kind: "duplicate"; key: string }
	| { kind: "inflight"; key: string };

type Entry = { state: "inflight" | "done"; at: number };

/** Compute the logical dedupe key for an inbound message. */
export function resolveDedupeKey(input: DedupeInput): string {
	const { messageId, chatId, senderOpenId, messageType, content, createTime } = input;

	let parsed: Record<string, unknown> = {};
	try {
		parsed = JSON.parse(content ?? "{}");
	} catch {
		parsed = {};
	}

	// Media: identity is stable via the resource key + owning message.
	const resourceKey = (parsed.image_key ?? parsed.file_key) as string | undefined;
	if (resourceKey && messageType !== "text" && messageType !== "post") {
		return `media:${messageId}:${resourceKey}`;
	}

	// Text/post: retry identity resilient to message_id churn.
	if ((messageType === "text" || messageType === "post") && createTime) {
		const hash = createHash("sha256").update(content ?? "").digest("hex").slice(0, 32);
		return `text-retry:${senderOpenId ?? "?"}:${chatId}:${createTime}:${hash}`;
	}

	// Fallback: the raw message_id.
	return `mid:${messageId}`;
}

export interface Deduper {
	claim(input: DedupeInput): ClaimResult;
	/** Drop expired entries; returns count removed. */
	sweep(): number;
	size(): number;
}

export function createDeduper(ttlMs: number): Deduper {
	const seen = new Map<string, Entry>();

	function sweep(): number {
		const now = Date.now();
		let removed = 0;
		for (const [key, entry] of seen) {
			// Keep inflight entries regardless of age; expire completed ones.
			if (entry.state === "done" && now - entry.at > ttlMs) {
				seen.delete(key);
				removed++;
			}
		}
		return removed;
	}

	function claim(input: DedupeInput): ClaimResult {
		const key = resolveDedupeKey(input);
		const existing = seen.get(key);
		if (existing) {
			if (existing.state === "inflight") return { kind: "inflight", key };
			if (Date.now() - existing.at <= ttlMs) return { kind: "duplicate", key };
			// Expired completed entry: fall through and re-claim.
		}

		seen.set(key, { state: "inflight", at: Date.now() });
		let settled = false;
		return {
			kind: "claimed",
			key,
			commit: () => {
				if (settled) return;
				settled = true;
				seen.set(key, { state: "done", at: Date.now() });
			},
			release: () => {
				if (settled) return;
				settled = true;
				// Failed/aborted: remove so a legitimate retry can re-process.
				if (seen.get(key)?.state === "inflight") seen.delete(key);
			},
		};
	}

	return { claim, sweep, size: () => seen.size };
}
