/**
 * FeishuStreamingSession — CardKit "typewriter" streaming for one agent turn.
 *
 * Simplified port of openclaw's `FeishuStreamingSession` (single card, single
 * turn — no generation/settlement race machine, which openclaw needs for
 * multi-payload / broadcast turns pi doesn't have).
 *
 * Flow:
 *   1. start()  — create a schema-2.0 card entity with `streaming_mode: true`
 *                 and send it (reply-threaded in groups, plain in DMs).
 *   2. update(fullText) — caller passes the FULL current snapshot; CardKit
 *                 derives the display delta. Throttled to `throttleMs`, with an
 *                 immediate force-flush on sentence punctuation or a large
 *                 delta, and a trailing timer otherwise. A monotonic
 *                 sequence + uuid orders/dedupes writes server-side.
 *   3. finalize(finalText) — flush the final snapshot, then turn
 *                 `streaming_mode` off so the card stops the typewriter.
 *
 * All card writes are serialized through an internal promise chain so out-of-
 * order HTTP completions can't scramble the card.
 */

import type { FeishuClient } from "./feishu-client.ts";
import { buildStreamingCard, buildStreamingFinalizeSettings } from "./message.ts";

const ELEMENT_ID = "content";
const SIGNIFICANT_DELTA_CHARS = 18;
const SENTENCE_END = /[\n。！？!?；;：:]\s*$/;

export interface StreamingSessionOptions {
	client: FeishuClient;
	chatId: string;
	/** Reply target message_id (thread the card onto it in groups). */
	replyToMessageId?: string;
	replyInThread: boolean;
	throttleMs: number;
	headerTitle?: string;
	log?: (msg: string) => void;
}

export class FeishuStreamingSession {
	private opts: StreamingSessionOptions;
	private cardId?: string;
	private messageId?: string;
	private sequence = 0;
	private sentText = "";
	private pendingText = "";
	private lastPushAt = 0;
	private flushTimer?: ReturnType<typeof setTimeout>;
	private writeChain: Promise<void> = Promise.resolve();
	private closed = false;
	private log: (msg: string) => void;

	constructor(opts: StreamingSessionOptions) {
		this.opts = opts;
		this.log = opts.log ?? (() => {});
	}

	get started(): boolean {
		return Boolean(this.cardId);
	}
	get visibleMessageId(): string | undefined {
		return this.messageId;
	}

	/** Create + send the streaming card. Returns false if CardKit is unavailable. */
	async start(): Promise<boolean> {
		const { client, chatId, replyToMessageId, replyInThread, throttleMs, headerTitle } = this.opts;
		if (!(await client.supportsCardKit())) return false;
		const cardJson = buildStreamingCard("", throttleMs, headerTitle);
		const cardId = await client.createCardEntity(cardJson);
		if (!cardId) return false;
		this.cardId = cardId;
		if (replyToMessageId) {
			this.messageId = await client.replyCardEntity(replyToMessageId, cardId, replyInThread);
		} else {
			this.messageId = await client.sendCardEntity(chatId, cardId);
		}
		this.log(`streaming card started (card_id=${cardId}, msg_id=${this.messageId ?? "?"})`);
		return Boolean(this.messageId);
	}

	/** Feed the current full snapshot; throttled push to the card. */
	update(fullText: string): void {
		if (this.closed || !this.cardId) return;
		this.pendingText = fullText;
		const now = Date.now();
		const delta = fullText.length - this.sentText.length;
		const force = SENTENCE_END.test(fullText) || delta >= SIGNIFICANT_DELTA_CHARS;
		const elapsed = now - this.lastPushAt;

		if (force || elapsed >= this.opts.throttleMs) {
			this.pushNow();
		} else if (!this.flushTimer) {
			const wait = Math.max(0, this.opts.throttleMs - elapsed);
			this.flushTimer = setTimeout(() => {
				this.flushTimer = undefined;
				this.pushNow();
			}, wait);
		}
	}

	private pushNow(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		const text = this.pendingText;
		if (text === this.sentText) return;
		this.lastPushAt = Date.now();
		const seq = ++this.sequence;
		const uuid = `s_${this.cardId}_${seq}`;
		const target = text;
		this.writeChain = this.writeChain.then(async () => {
			if (this.closed) return;
			try {
				await this.opts.client.streamCardContent(this.cardId as string, ELEMENT_ID, target, seq, uuid);
				this.sentText = target; // only advance on accepted write
			} catch (err) {
				this.log(`streaming update failed (seq=${seq}): ${(err as Error).message}`);
			}
		});
	}

	/**
	 * Flush the final text and stop streaming. Returns true if the card carries
	 * the final content (so the caller can skip the normal message send).
	 */
	async finalize(finalText: string): Promise<boolean> {
		if (this.closed || !this.cardId) return false;
		this.pendingText = finalText;
		this.pushNow();
		// Wait for queued writes to drain.
		await this.writeChain.catch(() => {});
		this.closed = true;
		const seq = ++this.sequence;
		try {
			await this.opts.client.patchCardSettings(this.cardId, buildStreamingFinalizeSettings(), seq);
		} catch (err) {
			this.log(`streaming finalize failed: ${(err as Error).message}`);
		}
		return Boolean(this.messageId) && this.sentText.length > 0;
	}

	/** Abandon the session without sending more (best effort). */
	async abandon(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		await this.writeChain.catch(() => {});
		if (this.cardId) {
			try {
				await this.opts.client.patchCardSettings(this.cardId, buildStreamingFinalizeSettings(), ++this.sequence);
			} catch {
				// best effort
			}
		}
	}
}
