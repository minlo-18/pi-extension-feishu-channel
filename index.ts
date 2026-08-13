/**
 * Feishu / Lark channel extension for pi-agent.
 *
 * Bridges a Feishu bot to a pi coding-agent session:
 *   - Inbound IM messages (WebSocket long-connection) are de-duplicated (logical
 *     retry identity), coalesced per sender (debounce), admitted through a gate
 *     (DM allowlist, group policy, @mention, bot filtering), and processed on a
 *     per-chat serial queue. Text becomes a user prompt; images inline; other
 *     files download locally and their paths are appended.
 *   - Assistant replies stream live into a CardKit "typewriter" card as tokens
 *     arrive (falls back to a normal message). Non-streamed replies with code
 *     blocks / tables render as a schema-2.0 card; other markdown as `post`.
 *   - Tool calls can be gated behind an interactive Approve/Deny card whose
 *     button clicks are token-deduped; the tool only runs after approval.
 *   - A `feishu_send_file` tool lets the agent push local images/files to chat.
 *
 * Architecture is adapted from hermes-agent's FeishuAdapter + openclaw's
 * feishu channel, re-expressed against pi's extension contract:
 *   - factory `(pi: ExtensionAPI) => void`     (entry)
 *   - `session_start`    -> connect            (de-facto "activate")
 *   - `message_start/update` -> stream card    (typewriter)
 *   - `tool_call`        -> optional card approval (blocking)
 *   - `agent_end`        -> finalize stream / deliver reply
 *   - `session_shutdown` -> disconnect         (de-facto "deactivate")
 *
 * pi runs a SINGLE agent session, so the channel binds one chat at a time and
 * serializes turns; other chats are told the agent is busy.
 */

import * as fs from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ImageContent, TextContent } from "@earendil-works/pi-coding-agent";
import { type FeishuConfig, loadConfig, saveCredentials } from "./config.ts";
import { createDeduper, type Deduper } from "./dedup.ts";
import { createInboundDebouncer, type InboundDebouncer } from "./debounce.ts";
import { type CardActionEvent, FeishuClient, type InboundMessageEvent } from "./feishu-client.ts";
import { runQrOnboarding } from "./onboarding.ts";
import {
	buildApprovalCard,
	buildOutboundPayload,
	buildResolvedCard,
	buildStaticContentCard,
	chunkText,
	extractAssistantText,
	extractMessageText,
	hasCodeOrTable,
	type MediaRef,
	normalizeInbound,
} from "./message.ts";
import { createSequentialQueue, type SequentialQueue } from "./queue.ts";
import { FeishuStreamingSession } from "./streaming-card.ts";

/** Reason an inbound message was not admitted. */
type RejectReason =
	| "self"
	| "bot"
	| "dm-not-allowed"
	| "group-disabled"
	| "group-not-allowed"
	| "no-mention"
	| "empty";

interface BoundChat {
	chatId: string;
	chatType: string;
	/** message_id to thread replies onto (group chats). */
	lastMessageId: string;
}

/** A pending tool-approval awaiting a card click. */
interface PendingApproval {
	resolve: (approved: boolean) => void;
	cardMessageId?: string;
	chatId: string;
	timer: ReturnType<typeof setTimeout>;
}

/** A card-action token claim (dedupes repeated button-click deliveries). */
interface TokenClaim {
	state: "inflight" | "completed";
	at: number;
}

const CARD_TOKEN_TTL_MS = 15 * 60 * 1000;

/** Map inbound media kind + name to the Feishu file_type enum for re-upload. */
function fileTypeForName(name: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
	const ext = name.toLowerCase().split(".").pop() ?? "";
	if (ext === "opus") return "opus";
	if (ext === "mp4") return "mp4";
	if (ext === "pdf") return "pdf";
	if (["doc", "docx"].includes(ext)) return "doc";
	if (["xls", "xlsx"].includes(ext)) return "xls";
	if (["ppt", "pptx"].includes(ext)) return "ppt";
	return "stream";
}

export default function feishuChannel(pi: ExtensionAPI): void {
	// Allow pointing at an explicit config file (useful for headless/Ubuntu).
	pi.registerFlag("feishu-config", { type: "string", description: "Path to feishu-channel JSON config" });

	let client: FeishuClient | undefined;
	let cfg: FeishuConfig | undefined;
	let boundChat: BoundChat | undefined;
	let contextRef: ExtensionContext | undefined;
	let started = false;

	// Inbound plumbing (created on connect once cfg is known).
	let deduper: Deduper | undefined;
	let debouncer: InboundDebouncer | undefined;
	let queue: SequentialQueue | undefined;
	let sweepTimer: ReturnType<typeof setInterval> | undefined;

	// Streaming state for the active turn.
	let stream: FeishuStreamingSession | undefined;
	let streamStartFailUntil = 0; // backoff timestamp after a failed start
	const STREAM_START_BACKOFF_MS = 60000;

	// "Processing" reaction on the triggering message for the active turn.
	let activeReaction: { messageId: string; reactionId?: string } | undefined;

	const pendingApprovals = new Map<string, PendingApproval>();
	const cardTokens = new Map<string, TokenClaim>();
	let approvalSeq = 0;

	const logLines: string[] = [];
	const log = (msg: string) => {
		const line = `[feishu-channel] ${msg}`;
		logLines.push(line);
		if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
		// stderr keeps the TUI transcript clean while remaining visible in logs.
		console.error(line);
	};

	/** Post text back to Feishu: static card for code/tables, else post/text. */
	async function deliver(target: BoundChat, text: string): Promise<void> {
		if (!client || !cfg || !text) return;

		// Static-card upgrade: code blocks / tables render best in a schema-2.0 card.
		if (cfg.staticCard && hasCodeOrTable(text) && text.length <= cfg.maxMessageLength) {
			try {
				const cardId = await client.createCardEntity(buildStaticContentCard(text));
				if (cardId) {
					if (cfg.replyInGroup && target.chatType !== "p2p" && target.lastMessageId) {
						await client.replyCardEntity(target.lastMessageId, cardId);
					} else {
						await client.sendCardEntity(target.chatId, cardId);
					}
					return;
				}
			} catch (err) {
				log(`static card failed, falling back: ${(err as Error).message}`);
			}
		}

		const chunks = chunkText(text, cfg.maxMessageLength);
		for (let i = 0; i < chunks.length; i++) {
			const { msgType, content } = buildOutboundPayload(chunks[i], cfg.richText);
			try {
				if (cfg.replyInGroup && target.chatType !== "p2p" && i === 0 && target.lastMessageId) {
					await client.replyToMessage(target.lastMessageId, msgType, content);
				} else {
					await client.sendToChat(target.chatId, msgType, content);
				}
			} catch (err) {
				log(`send failed (${msgType}): ${(err as Error).message}`);
				if (msgType === "post") {
					try {
						await client.sendToChat(target.chatId, "text", JSON.stringify({ text: chunks[i] }));
					} catch (err2) {
						log(`plain-text fallback failed: ${(err2 as Error).message}`);
					}
				}
			}
		}
	}

	/**
	 * Clear the active "processing" reaction. On failure, optionally swap it for
	 * the configured failure emoji instead of leaving nothing. Idempotent.
	 */
	async function clearReaction(failed: boolean): Promise<void> {
		const active = activeReaction;
		activeReaction = undefined;
		if (!client || !active) return;
		if (active.reactionId) {
			await client.removeReaction(active.messageId, active.reactionId);
		}
		if (failed && cfg?.reactFailEmoji) {
			await client.addReaction(active.messageId, cfg.reactFailEmoji);
		}
	}

	/** Admission gate — port of hermes `_admit` narrowed to pi's single-session model. */
	function admit(cfg: FeishuConfig, chatId: string, chatType: string, senderOpenId: string | undefined, senderType: string | undefined, mentionsBot: boolean): RejectReason | null {
		if (senderOpenId && client?.botOpenId && senderOpenId === client.botOpenId) return "self";

		const fromBot = senderType && senderType !== "user";
		if (fromBot) {
			if (cfg.allowBots === "none") return "bot";
			if (cfg.allowBots === "mentions" && !mentionsBot) return "bot";
		}

		if (chatType === "p2p") {
			if (cfg.allowAllUsers || cfg.allowedUsers.length === 0) return null;
			if (senderOpenId && cfg.allowedUsers.includes(senderOpenId)) return null;
			return "dm-not-allowed";
		}

		if (cfg.groupPolicy === "disabled") return "group-disabled";
		if (cfg.groupPolicy === "allowlist" && !cfg.allowedChats.includes(chatId)) return "group-not-allowed";
		if (cfg.requireMention && !mentionsBot) return "no-mention";
		return null;
	}

	/**
	 * Download inbound media and build pi content blocks + a textual manifest.
	 */
	async function collectMedia(
		messageId: string,
		media: MediaRef[],
	): Promise<{ images: ImageContent[]; fileNotes: string[] }> {
		const images: ImageContent[] = [];
		const fileNotes: string[] = [];
		if (!client || !cfg || media.length === 0) return { images, fileNotes };

		for (const ref of media) {
			const dl = await client.downloadResource({
				kind: ref.kind,
				messageId,
				imageKey: ref.imageKey,
				fileKey: ref.fileKey,
				fileName: ref.fileName,
				destDir: cfg.inboundDir,
			});
			if (!dl) {
				fileNotes.push(`[failed to download ${ref.kind}]`);
				continue;
			}
			if (ref.kind === "image") {
				try {
					const data = fs.readFileSync(dl.localPath).toString("base64");
					const mimeType = dl.fileName.toLowerCase().endsWith(".jpg") ? "image/jpeg" : "image/png";
					images.push({ type: "image", data, mimeType });
				} catch (err) {
					fileNotes.push(`[image saved to ${dl.localPath} (inline failed: ${(err as Error).message})]`);
				}
			} else {
				fileNotes.push(`[${ref.kind} saved to: ${dl.localPath}]`);
			}
		}
		return { images, fileNotes };
	}

	/** The sequential key for a chat (per-chat FIFO). */
	function chatKey(chatId: string): string {
		return `feishu:${chatId}`;
	}

	/**
	 * Stage 1 of inbound handling: dedup + admit + debounce.
	 * Runs synchronously off the WS callback; heavy work is deferred to the
	 * queue in the debounce flush.
	 */
	function onInbound(ev: InboundMessageEvent): void {
		if (!cfg || !client || !contextRef) return;

		const normalized = normalizeInbound({
			messageType: ev.messageType,
			content: ev.content,
			mentions: ev.mentions,
			botOpenId: client.botOpenId,
			botName: client.botName,
		});

		// Dedup: claim before doing anything else (drops transport redeliveries).
		let commit: (() => void) | undefined;
		let release: (() => void) | undefined;
		if (cfg.dedupEnabled && deduper) {
			const claim = deduper.claim({
				messageId: ev.messageId,
				chatId: ev.chatId,
				senderOpenId: ev.senderOpenId,
				messageType: ev.messageType,
				content: ev.content,
				createTime: ev.createTime,
			});
			if (claim.kind !== "claimed") {
				log(`dropped ${claim.kind} message (key=${claim.key})`);
				return;
			}
			commit = claim.commit;
			release = claim.release;
		}

		const reason = admit(cfg, ev.chatId, ev.chatType, ev.senderOpenId, ev.senderType, normalized.mentionsBot);
		if (reason) {
			log(`rejected message from ${ev.chatId} (${ev.chatType}): ${reason}`);
			release?.(); // not a duplicate; allow a genuine resend later
			return;
		}

		// Debounce: coalesce rapid text from the same sender. Media / disabled
		// debounce flush immediately as a single-item batch.
		const isPlainText = ev.messageType === "text" && normalized.media.length === 0;

		if (cfg.debounceEnabled && isPlainText && cfg.debounceMs > 0 && debouncer) {
			debouncer.push(`${ev.chatId}:${ev.senderOpenId ?? "?"}`, {
				messageId: ev.messageId,
				chatId: ev.chatId,
				chatType: ev.chatType,
				text: normalized.text,
				mentions: ev.mentions,
				mentionsBot: normalized.mentionsBot,
				commit,
			});
		} else {
			commit?.();
			void runTurn(
				{ chatId: ev.chatId, chatType: ev.chatType, lastMessageId: ev.messageId },
				ev.messageId,
				normalized.media,
				normalized.text,
				normalized.note,
			);
		}
	}

	/**
	 * Stage 2: on the per-chat serial queue — media download + bind + inject.
	 */
	async function runTurn(
		target: BoundChat,
		messageId: string,
		media: MediaRef[],
		text: string,
		note: string | undefined,
	): Promise<void> {
		if (!cfg || !client || !contextRef) return;
		const run = () => processTurn(target, messageId, media, text, note);
		if (cfg.queueEnabled && queue) {
			await queue.enqueue(chatKey(target.chatId), run);
		} else {
			await run();
		}
	}

	async function processTurn(
		target: BoundChat,
		messageId: string,
		media: MediaRef[],
		text: string,
		note: string | undefined,
	): Promise<void> {
		if (!cfg || !client || !contextRef) return;

		let images: ImageContent[] = [];
		let fileNotes: string[] = [];
		if (cfg.forwardMedia && media.length > 0) {
			const collected = await collectMedia(messageId, media);
			images = collected.images;
			fileNotes = collected.fileNotes;
		} else if (media.length > 0) {
			fileNotes = media.map((m) => `[${m.kind} attachment omitted — media forwarding disabled]`);
		}

		const textParts: string[] = [];
		if (text) textParts.push(text);
		if (fileNotes.length > 0) textParts.push(fileNotes.join("\n"));
		if (note) textParts.push(note);
		const promptText = textParts.join("\n\n").trim();

		if (!promptText && images.length === 0) {
			if (note) void deliver(target, `I couldn't read that message. ${note}`);
			return;
		}

		const ctx = contextRef;
		const idle = ctx.isIdle();

		if (idle || !boundChat) {
			boundChat = target;
		} else if (boundChat.chatId !== target.chatId) {
			void deliver(target, "The agent is currently busy in another conversation. Please try again shortly.");
			return;
		} else {
			boundChat.lastMessageId = target.lastMessageId;
		}

		log(`inbound -> agent (chat=${target.chatId}, idle=${idle}, images=${images.length}): ${promptText.slice(0, 80)}`);

		const content: (TextContent | ImageContent)[] = [];
		if (promptText) content.push({ type: "text", text: promptText });
		content.push(...images);
		const payload: string | (TextContent | ImageContent)[] = images.length > 0 ? content : promptText;

		try {
			if (idle) pi.sendUserMessage(payload);
			else pi.sendUserMessage(payload, { deliverAs: "followUp" });
		} catch (err) {
			log(`sendUserMessage failed: ${(err as Error).message}`);
			void deliver(target, `Failed to route your message: ${(err as Error).message}`);
			return;
		}

		// Add a "processing" reaction on the triggering message (typing/ack
		// feedback), tracked so agent_end can remove it. Only for a fresh turn
		// (idle) — a follow-up joins the in-flight turn whose reaction already
		// exists. Best effort; never blocks message routing.
		if (cfg.reactEnabled && client && idle && !activeReaction) {
			const reactMsgId = target.lastMessageId;
			activeReaction = { messageId: reactMsgId };
			void client.addReaction(reactMsgId, cfg.reactEmoji).then((reactionId) => {
				// Guard against a turn that already ended before the add returned.
				if (activeReaction?.messageId === reactMsgId) activeReaction.reactionId = reactionId;
				else if (reactionId) void client?.removeReaction(reactMsgId, reactionId);
			});
		}
	}

	/** Resolve a pending approval when its card button is clicked. */
	function onCardAction(ev: CardActionEvent): void {
		// Token dedup: Feishu may redeliver the same click.
		const token = String(ev.value?.token ?? `${ev.messageId}:${ev.value?.feishuApproval ?? ""}`);
		const existing = cardTokens.get(token);
		if (existing) {
			log(`ignoring duplicate card action (token=${token}, state=${existing.state})`);
			return;
		}
		cardTokens.set(token, { state: "inflight", at: Date.now() });

		const approvalId = String(ev.value?.feishuApproval ?? "");
		if (!approvalId) {
			cardTokens.set(token, { state: "completed", at: Date.now() });
			return;
		}
		const pending = pendingApprovals.get(approvalId);
		if (!pending) {
			cardTokens.set(token, { state: "completed", at: Date.now() });
			return;
		}
		const approved = String(ev.value?.decision ?? "") === "approve";
		log(`approval ${approvalId} -> ${approved ? "approve" : "deny"} by ${ev.operatorOpenId}`);
		clearTimeout(pending.timer);
		pendingApprovals.delete(approvalId);
		if (client && pending.cardMessageId) {
			void client.updateCard(
				pending.cardMessageId,
				buildResolvedCard(approved ? "✅ Approved" : "⛔ Denied", approved ? "green" : "red"),
			);
		}
		cardTokens.set(token, { state: "completed", at: Date.now() });
		pending.resolve(approved);
	}

	/** Whether a given tool name requires card approval. */
	function needsApproval(cfg: FeishuConfig, toolName: string): boolean {
		if (!cfg.approvalEnabled) return false;
		if (cfg.approvalTools.length === 0 || cfg.approvalTools.includes("*")) return true;
		return cfg.approvalTools.includes(toolName);
	}

	/** Build inbound plumbing + open the WS connection for a resolved config. */
	async function connectWith(resolved: FeishuConfig, ctx: ExtensionContext): Promise<boolean> {
		cfg = resolved;
		client = new FeishuClient(resolved, log);

		// Verify credentials BEFORE building plumbing / opening the WS. The WS
		// client fails asynchronously on a bad app_id (it never throws from
		// start()), which previously left us marked "connected" with a dead
		// socket. A tenant_access_token probe catches bad/placeholder creds up
		// front so we can fall through to QR onboarding instead.
		const verify = await client.verifyCredentials();
		if (!verify.ok) {
			const detail = `${verify.message ?? "invalid credentials"}${verify.code !== undefined ? ` (code ${verify.code})` : ""}`;
			log(`credential check failed: ${detail}`);
			if (ctx.hasUI) ctx.ui.notify(`Feishu credentials invalid: ${detail}`, "warning");
			client = undefined;
			cfg = undefined;
			return false;
		}

		if (resolved.dedupEnabled) {
			deduper = createDeduper(resolved.dedupTtlMs);
		}
		// Periodic sweep: expire dedup entries and old card-action tokens.
		if (!sweepTimer) {
			sweepTimer = setInterval(() => {
				deduper?.sweep();
				const now = Date.now();
				for (const [token, claim] of cardTokens) {
					if (now - claim.at > CARD_TOKEN_TTL_MS) cardTokens.delete(token);
				}
			}, 60000);
			if (typeof sweepTimer.unref === "function") sweepTimer.unref();
		}
		if (resolved.queueEnabled) {
			queue = createSequentialQueue({
				taskTimeoutMs: resolved.queueTaskTimeoutMs,
				onTaskTimeout: (key) => log(`queue task evicted after timeout (key=${key}); still running in background`),
			});
		}
		if (resolved.debounceEnabled) {
			debouncer = createInboundDebouncer(resolved.debounceMs, (_key, turn) => {
				for (const part of turn.parts) part.commit?.();
				const target: BoundChat = {
					chatId: turn.chatId,
					chatType: turn.chatType,
					lastMessageId: turn.lastMessageId,
				};
				void runTurn(target, turn.lastMessageId, [], turn.text, undefined);
			});
		}

		try {
			await client.hydrateBotIdentity();
			await client.connect((ev) => onInbound(ev), resolved.approvalEnabled ? onCardAction : undefined);
			started = true;
			log(
				`connected (domain=${resolved.domain}, requireMention=${resolved.requireMention}, groupPolicy=${resolved.groupPolicy}, ` +
					`streaming=${resolved.streaming}, staticCard=${resolved.staticCard}, dedup=${resolved.dedupEnabled}, ` +
					`debounce=${resolved.debounceEnabled}, queue=${resolved.queueEnabled}, approval=${resolved.approvalEnabled})`,
			);
			if (ctx.hasUI) ctx.ui.notify("Feishu channel connected", "info");
			if (ctx.hasUI) ctx.ui.setStatus("feishu", "🪽 Feishu");
			return true;
		} catch (err) {
			log(`connect failed: ${(err as Error).message}`);
			if (ctx.hasUI) ctx.ui.notify(`Feishu channel connect failed: ${(err as Error).message}`, "error");
			return false;
		}
	}

	/**
	 * Run the QR scan-to-create/select flow, persist the returned credentials,
	 * then load the full config and connect. Returns true on success.
	 */
	async function attemptOnboarding(ctx: ExtensionContext, domain: "feishu" | "lark", credentialsPath: string): Promise<boolean> {
		if (started) return true;
		try {
			log("starting QR onboarding…");
			if (ctx.hasUI) ctx.ui.notify("Feishu: scan the QR code in your terminal to log in", "info");
			const result = await runQrOnboarding({ domain, log, out: (t) => process.stdout.write(t) });
			const saved = saveCredentials(credentialsPath, result);
			log(`credentials saved to ${saved}`);
			// Re-load full config from the freshly written file, then connect.
			const reloaded = loadConfig({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				configPathFlag: saved,
			});
			if (!reloaded.config) {
				log(`post-onboarding config load failed: ${reloaded.error ?? "unknown"}`);
				return false;
			}
			return await connectWith(reloaded.config, ctx);
		} catch (err) {
			log(`onboarding failed: ${(err as Error).message}`);
			if (ctx.hasUI) ctx.ui.notify(`Feishu onboarding failed: ${(err as Error).message}`, "error");
			return false;
		}
	}

	// ----- Lifecycle: activate on session start ------------------------------
	pi.on("session_start", async (_event, ctx) => {
		contextRef = ctx;
		if (started) return; // only connect once per process
		const configPathFlag = (pi.getFlag("feishu-config") as string | undefined) || undefined;
		const result = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), configPathFlag });

		const interactive = process.stdout.isTTY === true;
		const onboardingAllowed = result.config ? result.config.onboarding : result.needsOnboarding !== false;

		if (result.config) {
			// Credentials present — try to connect. If they turn out invalid
			// (probe fails), fall through to QR onboarding on an interactive TTY.
			const ok = await connectWith(result.config, ctx);
			if (ok) return;
			if (interactive && onboardingAllowed) {
				log("configured credentials failed; falling back to QR onboarding");
				await attemptOnboarding(ctx, result.domain ?? result.config.domain, result.credentialsPath ?? "");
			}
			return;
		}

		// No credentials. Default to QR onboarding when enabled and we have an
		// interactive terminal to print the QR into. Otherwise, guide the user.
		if (result.needsOnboarding && interactive) {
			await attemptOnboarding(ctx, result.domain ?? "feishu", result.credentialsPath ?? "");
			return;
		}

		log(result.error ?? "configuration error");
		if (ctx.hasUI) {
			const hint = result.needsOnboarding
				? `${result.error} (run /feishu-login to scan a QR code)`
				: result.error;
			ctx.ui.notify(`Feishu channel disabled: ${hint}`, "warning");
		}
	});

	// ----- Streaming: start the card on first assistant token ----------------
	pi.on("message_update", async (event) => {
		if (!cfg?.streaming || !client || !boundChat) return;
		const text = extractMessageText(event.message);
		if (!text) return;

		if (!stream) {
			if (Date.now() < streamStartFailUntil) return; // in backoff
			const target = boundChat;
			const session = new FeishuStreamingSession({
				client,
				chatId: target.chatId,
				replyToMessageId: cfg.replyInGroup && target.chatType !== "p2p" ? target.lastMessageId : undefined,
				replyInThread: target.chatType !== "p2p",
				throttleMs: cfg.streamingThrottleMs,
				log,
			});
			stream = session;
			const ok = await session.start().catch((err) => {
				log(`streaming start error: ${(err as Error).message}`);
				return false;
			});
			if (!ok) {
				streamStartFailUntil = Date.now() + STREAM_START_BACKOFF_MS;
				stream = undefined;
				return;
			}
		}
		stream.update(text);
	});

	// ----- Tool-call approval via interactive card ---------------------------
	pi.on("tool_call", async (event) => {
		if (!cfg || !client || !boundChat || !cfg.approvalEnabled) return;
		if (!needsApproval(cfg, event.toolName)) return;

		const approvalId = `ap_${Date.now()}_${++approvalSeq}`;
		const target = boundChat;
		const timeoutMs = cfg.approvalTimeoutMs;
		const timeoutAllow = cfg.approvalTimeoutAllow;
		let summary: string;
		try {
			summary = "```json\n" + JSON.stringify(event.input, null, 2).slice(0, 1500) + "\n```";
		} catch {
			summary = "(unserializable arguments)";
		}

		const approved = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				pendingApprovals.delete(approvalId);
				log(`approval ${approvalId} timed out -> ${timeoutAllow ? "allow" : "deny"}`);
				resolve(timeoutAllow);
			}, timeoutMs);

			const pending: PendingApproval = { resolve, chatId: target.chatId, timer };
			pendingApprovals.set(approvalId, pending);

			void (async () => {
				try {
					const card = buildApprovalCard({ approvalId, toolName: event.toolName, summary });
					const msgId = await client?.sendCard(target.chatId, card);
					pending.cardMessageId = msgId;
				} catch (err) {
					log(`failed to send approval card: ${(err as Error).message}`);
					clearTimeout(timer);
					pendingApprovals.delete(approvalId);
					resolve(timeoutAllow);
				}
			})();
		});

		if (!approved) {
			return { block: true, reason: `Denied via Feishu approval card (tool: ${event.toolName})` };
		}
		return;
	});

	// ----- Deliver assistant replies to Feishu -------------------------------
	pi.on("agent_end", async (event) => {
		if (!boundChat || !cfg) return;
		const messages = (event.messages ?? []) as Array<{ role?: string; content?: unknown }>;
		const text = extractAssistantText(messages);

		// Clear the "processing" reaction: remove on success, or swap to the
		// failure emoji when the turn produced no visible reply.
		await clearReaction(!text);

		// If we streamed a card this turn, finalize it and (if it carries the
		// content) skip the redundant message send.
		if (stream) {
			const session = stream;
			stream = undefined;
			try {
				const carried = await session.finalize(text);
				if (carried) return;
			} catch (err) {
				log(`streaming finalize error: ${(err as Error).message}`);
			}
		}

		if (!text) return;
		await deliver(boundChat, text);
	});

	// ----- Outbound media tool: agent -> Feishu ------------------------------
	pi.registerTool({
		name: "feishu_send_file",
		label: "Send file to Feishu",
		description:
			"Send a local image or file to the currently bound Feishu chat. Use for screenshots, " +
			"generated artifacts, logs, etc. Provide an absolute local path.",
		parameters: Type.Object({
			path: Type.String({ description: "Absolute local path to the image or file to send" }),
			kind: Type.Optional(
				Type.String({ description: 'Either "image" or "file" (default: inferred from extension)' }),
			),
		}),
		async execute(_toolCallId, params) {
			if (!client || !boundChat) {
				return { content: [{ type: "text", text: "No Feishu chat is bound; cannot send." }], details: {} };
			}
			const filePath = String(params.path);
			if (!fs.existsSync(filePath)) {
				return { content: [{ type: "text", text: `File not found: ${filePath}` }], details: {} };
			}
			const isImage =
				String(params.kind ?? "").toLowerCase() === "image" || /\.(png|jpe?g|gif|webp|bmp)$/i.test(filePath);
			try {
				if (isImage) {
					const imageKey = await client.uploadImage(filePath);
					if (!imageKey) throw new Error("upload returned no image_key");
					await client.sendImageKey(boundChat.chatId, imageKey);
				} else {
					const name = filePath.split(/[\\/]/).pop() ?? "file";
					const fileKey = await client.uploadFile(filePath, fileTypeForName(name), name);
					if (!fileKey) throw new Error("upload returned no file_key");
					await client.sendFileKey(boundChat.chatId, fileKey);
				}
				return {
					content: [{ type: "text", text: `Sent ${isImage ? "image" : "file"} to Feishu: ${filePath}` }],
					details: { path: filePath, kind: isImage ? "image" : "file" },
				};
			} catch (err) {
				return { content: [{ type: "text", text: `Failed to send: ${(err as Error).message}` }], details: {} };
			}
		},
	});

	// ----- Manual test command ----------------------------------------------
	pi.registerCommand("feishu-status", {
		description: "Show Feishu channel status and recent log lines",
		handler: async (_args, ctx) => {
			const status = started ? "connected" : "not connected";
			const bound = boundChat ? `${boundChat.chatId} (${boundChat.chatType})` : "none";
			const feats = cfg
				? `stream=${cfg.streaming} card=${cfg.staticCard} react=${cfg.reactEnabled}(${cfg.reactEmoji}) dedup=${cfg.dedupEnabled} debounce=${cfg.debounceEnabled} queue=${cfg.queueEnabled} approval=${cfg.approvalEnabled}`
				: "(no config)";
			const recent = logLines.slice(-8).join("\n") || "(no log lines yet)";
			ctx.ui.notify(`Feishu: ${status}; bound: ${bound}; ${feats}\n${recent}`, "info");
		},
	});

	// ----- QR login command: scan to create/select a bot ---------------------
	pi.registerCommand("feishu-login", {
		description: "Scan a QR code to create or select a Feishu bot, then connect (prints QR to terminal)",
		handler: async (args, ctx) => {
			if (started) {
				ctx.ui.notify("Feishu channel is already connected. Use /feishu-status.", "info");
				return;
			}
			// Resolve domain + persistence path from whatever config layers exist.
			const configPathFlag = (pi.getFlag("feishu-config") as string | undefined) || undefined;
			const result = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), configPathFlag });
			const domain: "feishu" | "lark" = args.trim().toLowerCase() === "lark" ? "lark" : result.domain ?? "feishu";
			const credentialsPath = result.credentialsPath ?? "";
			ctx.ui.notify("Feishu QR login started — check your terminal for the QR code.", "info");
			const ok = await attemptOnboarding(ctx, domain, credentialsPath);
			ctx.ui.notify(ok ? "Feishu connected." : "Feishu login did not complete (see logs).", ok ? "info" : "warning");
		},
	});

	// ----- Lifecycle: deactivate on shutdown ---------------------------------
	pi.on("session_shutdown", async () => {
		if (sweepTimer) clearInterval(sweepTimer);
		sweepTimer = undefined;
		debouncer?.flushAll();
		await clearReaction(false);
		if (stream) {
			await stream.abandon().catch(() => {});
			stream = undefined;
		}
		for (const [, pending] of pendingApprovals) {
			clearTimeout(pending.timer);
			pending.resolve(false);
		}
		pendingApprovals.clear();
		cardTokens.clear();
		await client?.disconnect();
		client = undefined;
		boundChat = undefined;
		deduper = undefined;
		debouncer = undefined;
		queue = undefined;
		started = false;
		log("disconnected");
	});
}
