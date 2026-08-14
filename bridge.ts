/**
 * Feishu / Lark channel extension for pi-agent.
 *
 * Architecture:
 * - One WebSocket connection per extension process.
 * - One managed pi AgentSession per Feishu chat, persisted under `.pi/feishu-sessions/`.
 * - `/new` truly creates a fresh session for the current chat instead of asking
 *   the operator to reset from the terminal.
 * - Streaming cards, approval cards, reactions, dedup/debounce/queueing all stay
 *   scoped to the chat session that produced them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type InlineExtension,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type FeishuConfig, loadConfig, saveCredentials } from "./config.ts";
import { createDeduper, type Deduper } from "./dedup.ts";
import { createInboundDebouncer, type InboundDebouncer } from "./debounce.ts";
import { type CardActionEvent, FeishuClient, type InboundMessageEvent } from "./feishu-client.ts";
import { formatHelp, formatModelList, matchModel, parseCommand, parseThinkingLevel } from "./commands.ts";
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
import { type SessionStore, getSessionDir, loadSessionStore, saveSessionStore } from "./session-store.ts";
import { FeishuStreamingSession } from "./streaming-card.ts";

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
	lastMessageId: string;
}

interface ChatSessionState extends BoundChat {
	session: AgentSession;
	unsubscribe: () => void;
	stream?: FeishuStreamingSession;
	streamStartFailUntil: number;
	activeReaction?: { messageId: string; reactionId?: string };
}

interface PendingApproval {
	resolve: (approved: boolean) => void;
	cardMessageId?: string;
	chatId: string;
	sessionId: string;
	timer: ReturnType<typeof setTimeout>;
}

interface SessionOptions {
	reset?: boolean;
}

type TextContent = { type: "text"; text: string };
type ImageContent = { type: "image"; data: string; mimeType: string };

const CARD_TOKEN_TTL_MS = 15 * 60 * 1000;
const STREAM_START_BACKOFF_MS = 60 * 1000;

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
	pi.registerFlag("feishu-config", { type: "string", description: "Path to feishu-channel JSON config" });

	let client: FeishuClient | undefined;
	let cfg: FeishuConfig | undefined;
	let contextRef: ExtensionContext | undefined;
	let started = false;

	let deduper: Deduper | undefined;
	let debouncer: InboundDebouncer | undefined;
	let queue: SequentialQueue | undefined;
	let sweepTimer: ReturnType<typeof setInterval> | undefined;

	let sessionStore: SessionStore | undefined;
	let sessionStoreCwd: string | undefined;
	let sharedModelRuntimePromise: Promise<ModelRuntime> | undefined;

	const chatSessions = new Map<string, ChatSessionState>();
	const chatSessionPromises = new Map<string, Promise<ChatSessionState>>();
	const pendingApprovals = new Map<string, PendingApproval>();
	const cardTokens = new Map<string, { state: "inflight" | "completed"; at: number }>();
	let approvalSeq = 0;

	const logLines: string[] = [];
	const log = (msg: string) => {
		const line = `[feishu-channel] ${msg}`;
		logLines.push(line);
		if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
		console.error(line);
	};

	function ensureStoreLoaded(cwd: string): SessionStore {
		if (!sessionStore || sessionStoreCwd !== cwd) {
			sessionStore = loadSessionStore(cwd);
			sessionStoreCwd = cwd;
		}
		return sessionStore;
	}

	function saveStore(): void {
		if (!sessionStore || !sessionStoreCwd) return;
		saveSessionStore(sessionStoreCwd, sessionStore);
	}

	function getStoredSessionFile(chatId: string): string | undefined {
		return sessionStore?.chats[chatId]?.sessionFile;
	}

	function rememberSession(chatId: string, sessionFile: string | undefined): void {
		if (!sessionStore || !sessionStoreCwd || !sessionFile) return;
		sessionStore.chats[chatId] = { sessionFile, updatedAt: new Date().toISOString() };
		saveStore();
	}

	async function getSharedModelRuntime(agentDir: string): Promise<ModelRuntime> {
		if (!sharedModelRuntimePromise) {
			sharedModelRuntimePromise = ModelRuntime.create({
				authPath: path.join(agentDir, "auth.json"),
				modelsPath: path.join(agentDir, "models.json"),
			});
		}
		return sharedModelRuntimePromise;
	}

	async function getAvailableModels(agentDir: string): Promise<
		Array<{ id: string; name: string; provider: string; reasoning: boolean; actual: unknown }>
	> {
		const runtime = await getSharedModelRuntime(agentDir);
		try {
			await runtime.getAvailable();
		} catch {
			// Snapshot fallback is still useful for listing configured models.
		}
		return [...runtime.getAvailableSnapshot()].map((model) => ({
			id: model.id,
			name: model.name,
			provider: model.provider,
			reasoning: Boolean((model as { reasoning?: boolean }).reasoning),
			actual: model,
		}));
	}

	async function deliver(target: BoundChat, text: string): Promise<void> {
		if (!client || !cfg || !text) return;

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

	function admit(
		resolved: FeishuConfig,
		chatId: string,
		chatType: string,
		senderOpenId: string | undefined,
		senderType: string | undefined,
		mentionsBot: boolean,
	): RejectReason | null {
		if (senderOpenId && client?.botOpenId && senderOpenId === client.botOpenId) return "self";

		const fromBot = senderType && senderType !== "user";
		if (fromBot) {
			if (resolved.allowBots === "none") return "bot";
			if (resolved.allowBots === "mentions" && !mentionsBot) return "bot";
		}

		if (chatType === "p2p") {
			if (resolved.allowAllUsers || resolved.allowedUsers.length === 0) return null;
			if (senderOpenId && resolved.allowedUsers.includes(senderOpenId)) return null;
			return "dm-not-allowed";
		}

		if (resolved.groupPolicy === "disabled") return "group-disabled";
		if (resolved.groupPolicy === "allowlist" && !resolved.allowedChats.includes(chatId)) return "group-not-allowed";
		if (resolved.requireMention && !mentionsBot) return "no-mention";
		return null;
	}

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

	async function clearReaction(state: ChatSessionState, failed: boolean): Promise<void> {
		const active = state.activeReaction;
		state.activeReaction = undefined;
		if (!client || !active) return;
		if (active.reactionId) {
			await client.removeReaction(active.messageId, active.reactionId);
		}
		if (failed && cfg?.reactFailEmoji) {
			await client.addReaction(active.messageId, cfg.reactFailEmoji);
		}
	}

	function cancelPendingApprovalsForSession(sessionId: string): void {
		for (const [approvalId, pending] of pendingApprovals) {
			if (pending.sessionId !== sessionId) continue;
			clearTimeout(pending.timer);
			pendingApprovals.delete(approvalId);
			pending.resolve(false);
		}
	}

	async function requestApproval(
		state: ChatSessionState,
		toolName: string,
		input: Record<string, unknown>,
	): Promise<boolean> {
		if (!cfg || !client) return true;

		const approvalId = `ap_${Date.now()}_${++approvalSeq}`;
		const timeoutMs = cfg.approvalTimeoutMs;
		const timeoutAllow = cfg.approvalTimeoutAllow;
		let summary: string;
		try {
			summary = "```json\n" + JSON.stringify(input, null, 2).slice(0, 1500) + "\n```";
		} catch {
			summary = "(unserializable arguments)";
		}

		return await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				pendingApprovals.delete(approvalId);
				log(`approval ${approvalId} timed out -> ${timeoutAllow ? "allow" : "deny"}`);
				resolve(timeoutAllow);
			}, timeoutMs);

			const pending: PendingApproval = {
				resolve,
				chatId: state.chatId,
				sessionId: state.session.sessionId,
				timer,
			};
			pendingApprovals.set(approvalId, pending);

			void (async () => {
				try {
					const card = buildApprovalCard({ approvalId, toolName, summary });
					const msgId = await client?.sendCard(state.chatId, card);
					pending.cardMessageId = msgId;
				} catch (err) {
					log(`failed to send approval card: ${(err as Error).message}`);
					clearTimeout(timer);
					pendingApprovals.delete(approvalId);
					resolve(timeoutAllow);
				}
			})();
		});
	}

	function needsApproval(resolved: FeishuConfig, toolName: string): boolean {
		if (!resolved.approvalEnabled) return false;
		if (resolved.approvalTools.length === 0 || resolved.approvalTools.includes("*")) return true;
		return resolved.approvalTools.includes(toolName);
	}

	function createApprovalExtension(stateRef: { current?: ChatSessionState }): InlineExtension {
		return {
			name: "feishu_session_approval",
			hidden: true,
			factory(api) {
				api.on("tool_call", async (event) => {
					const state = stateRef.current;
					if (!state || !cfg || !needsApproval(cfg, event.toolName)) return;
					const approved = await requestApproval(state, event.toolName, event.input);
					if (!approved) {
						return { block: true, reason: `Denied via Feishu approval card (tool: ${event.toolName})` };
					}
					return;
				});
			},
		};
	}

	function createFeishuSendFileTool(stateRef: { current?: ChatSessionState }): ToolDefinition {
		return {
			name: "feishu_send_file",
			label: "Send file to Feishu",
			description:
				"Send a local image or file to the current Feishu chat session. " +
				"Provide an absolute local path.",
			parameters: Type.Object({
				path: Type.String({ description: "Absolute local path to the image or file to send" }),
				kind: Type.Optional(
					Type.String({ description: 'Either "image" or "file" (default: inferred from extension)' }),
				),
			}),
			async execute(_toolCallId, params) {
				const input = params as { path: string; kind?: string };
				const state = stateRef.current;
				if (!client || !state) {
					return { content: [{ type: "text", text: "No Feishu chat is bound; cannot send." }], details: {} };
				}

				const filePath = String(input.path);
				if (!fs.existsSync(filePath)) {
					return { content: [{ type: "text", text: `File not found: ${filePath}` }], details: {} };
				}

				const isImage =
					String(input.kind ?? "").toLowerCase() === "image" || /\.(png|jpe?g|gif|webp|bmp)$/i.test(filePath);
				try {
					if (isImage) {
						const imageKey = await client.uploadImage(filePath);
						if (!imageKey) throw new Error("upload returned no image_key");
						await client.sendImageKey(state.chatId, imageKey);
					} else {
						const name = filePath.split(/[\\/]/).pop() ?? "file";
						const fileKey = await client.uploadFile(filePath, fileTypeForName(name), name);
						if (!fileKey) throw new Error("upload returned no file_key");
						await client.sendFileKey(state.chatId, fileKey);
					}
					return {
						content: [{ type: "text", text: `Sent ${isImage ? "image" : "file"} to Feishu: ${filePath}` }],
						details: { path: filePath, kind: isImage ? "image" : "file" },
					};
				} catch (err) {
					return {
						content: [{ type: "text", text: `Failed to send: ${(err as Error).message}` }],
						details: {},
					};
				}
			},
		};
	}

	async function handleManagedSessionEvent(state: ChatSessionState, event: AgentSessionEvent): Promise<void> {
		if (chatSessions.get(state.chatId) !== state || !client || !cfg) return;

		if (event.type === "message_update") {
			if (!cfg.streaming) return;
			const text = extractMessageText(event.message);
			if (!text) return;

			if (!state.stream) {
				if (Date.now() < state.streamStartFailUntil) return;
				const session = new FeishuStreamingSession({
					client,
					chatId: state.chatId,
					replyToMessageId: cfg.replyInGroup && state.chatType !== "p2p" ? state.lastMessageId : undefined,
					replyInThread: state.chatType !== "p2p",
					throttleMs: cfg.streamingThrottleMs,
					log,
				});
				state.stream = session;
				const ok = await session.start().catch((err) => {
					log(`streaming start error: ${(err as Error).message}`);
					return false;
				});
				if (!ok) {
					state.streamStartFailUntil = Date.now() + STREAM_START_BACKOFF_MS;
					state.stream = undefined;
					return;
				}
			}
			state.stream.update(text);
			return;
		}

		if (event.type === "agent_end") {
			const text = extractAssistantText(event.messages as Array<{ role?: string; content?: unknown }>);
			await clearReaction(state, !text);

			if (state.stream) {
				const session = state.stream;
				state.stream = undefined;
				try {
					const carried = await session.finalize(text);
					if (carried) return;
				} catch (err) {
					log(`streaming finalize error: ${(err as Error).message}`);
				}
			}

			if (!text) return;
			await deliver(state, text);
			return;
		}

		if (event.type === "agent_settled") {
			if (state.stream) {
				await state.stream.abandon().catch(() => {});
				state.stream = undefined;
			}
			if (state.activeReaction) {
				await clearReaction(state, false);
			}
		}
	}

	async function disposeChatSession(state: ChatSessionState): Promise<void> {
		cancelPendingApprovalsForSession(state.session.sessionId);
		if (state.stream) {
			await state.stream.abandon().catch(() => {});
			state.stream = undefined;
		}
		if (state.activeReaction) {
			await clearReaction(state, false);
		}
		state.unsubscribe();
		state.session.dispose();
		chatSessions.delete(state.chatId);
	}

	async function createChatSession(target: BoundChat, sessionFile?: string): Promise<ChatSessionState> {
		const ctx = contextRef;
		if (!ctx) throw new Error("Feishu channel context is not ready");

		const cwd = ctx.cwd;
		const agentDir = getAgentDir();
		const sessionDir = getSessionDir(cwd);
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
		settingsManager.setProjectTrusted(ctx.isProjectTrusted());

		const stateRef: { current?: ChatSessionState } = {};
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			extensionFactories: [createApprovalExtension(stateRef)],
		});
		await resourceLoader.reload();

		let sessionManager: SessionManager;
		try {
			sessionManager =
				sessionFile && fs.existsSync(sessionFile)
					? SessionManager.open(sessionFile, sessionDir, cwd)
					: SessionManager.create(cwd, sessionDir);
		} catch (err) {
			log(`failed to open stored session for ${target.chatId}: ${(err as Error).message}`);
			sessionManager = SessionManager.create(cwd, sessionDir);
		}

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: await getSharedModelRuntime(agentDir),
			resourceLoader,
			sessionManager,
			settingsManager,
			customTools: [createFeishuSendFileTool(stateRef)],
		});

		const state: ChatSessionState = {
			...target,
			session,
			unsubscribe: () => {},
			streamStartFailUntil: 0,
		};
		stateRef.current = state;
		state.unsubscribe = session.subscribe((event) => {
			void handleManagedSessionEvent(state, event);
		});

		rememberSession(target.chatId, session.sessionFile);
		log(`chat session ready (chat=${target.chatId}, session=${session.sessionId})`);
		return state;
	}

	async function ensureChatSession(target: BoundChat, options: SessionOptions = {}): Promise<ChatSessionState> {
		const existingPromise = chatSessionPromises.get(target.chatId);
		if (existingPromise) {
			const state = await existingPromise;
			if (!options.reset) {
				state.chatType = target.chatType;
				state.lastMessageId = target.lastMessageId;
				return state;
			}
		}

		if (options.reset) {
			const existing = chatSessions.get(target.chatId);
			if (existing) {
				await disposeChatSession(existing);
			}
		} else {
			const existing = chatSessions.get(target.chatId);
			if (existing) {
				existing.chatType = target.chatType;
				existing.lastMessageId = target.lastMessageId;
				return existing;
			}
		}

		const promise = (async () => {
			const state = await createChatSession(target, options.reset ? undefined : getStoredSessionFile(target.chatId));
			chatSessions.set(target.chatId, state);
			return state;
		})();
		chatSessionPromises.set(target.chatId, promise);
		try {
			return await promise;
		} finally {
			chatSessionPromises.delete(target.chatId);
		}
	}

	function chatKey(chatId: string): string {
		return `feishu:${chatId}`;
	}

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
			fileNotes = media.map((m) => `[${m.kind} attachment omitted - media forwarding disabled]`);
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

		const state = await ensureChatSession(target);
		const idle = state.session.isIdle;

		log(
			`inbound -> session (chat=${target.chatId}, session=${state.session.sessionId}, idle=${idle}, images=${images.length}): ` +
				`${promptText.slice(0, 80)}`,
		);

		const content: (TextContent | ImageContent)[] = [];
		if (promptText) content.push({ type: "text", text: promptText });
		content.push(...images);
		const payload: string | (TextContent | ImageContent)[] = images.length > 0 ? content : promptText;

		const sendPromise = idle
			? state.session.sendUserMessage(payload)
			: state.session.sendUserMessage(payload, { deliverAs: "followUp" });
		void sendPromise.catch((err) => {
			log(`sendUserMessage failed: ${(err as Error).message}`);
			void deliver(target, `Failed to route your message: ${(err as Error).message}`);
		});

		if (cfg.reactEnabled && idle && !state.activeReaction) {
			const reactMsgId = target.lastMessageId;
			state.activeReaction = { messageId: reactMsgId };
			void client.addReaction(reactMsgId, cfg.reactEmoji).then((reactionId) => {
				const liveState = chatSessions.get(target.chatId);
				if (liveState === state && state.activeReaction?.messageId === reactMsgId) {
					state.activeReaction.reactionId = reactionId;
				} else if (reactionId) {
					void client?.removeReaction(reactMsgId, reactionId);
				}
			});
		}
	}

	async function runChatCommand(target: BoundChat, name: string, arg: string): Promise<void> {
		if (!cfg || !client || !contextRef) return;
		const run = () => handleChatCommand(name, arg, target);
		if (cfg.queueEnabled && queue) {
			await queue.enqueue(chatKey(target.chatId), run);
		} else {
			await run();
		}
	}

	async function handleChatCommand(name: string, arg: string, target: BoundChat): Promise<void> {
		const ctx = contextRef;
		if (!ctx || !cfg) return;
		const reply = (text: string) => deliver(target, text);
		const agentDir = getAgentDir();

		switch (name) {
			case "help":
			case "commands":
				await reply(formatHelp());
				return;

			case "stop": {
				const state = await ensureChatSession(target);
				if (state.session.isIdle) {
					await reply("Nothing is running right now.");
				} else {
					await state.session.abort();
					await reply("Stopped the current reply for this chat.");
				}
				return;
			}

			case "status": {
				const state = await ensureChatSession(target);
				const model = state.session.model ? `${state.session.model.name} (\`${state.session.model.id}\`)` : "unknown";
				const think = state.session.thinkingLevel;
				const usage = state.session.getContextUsage();
				const ctxLine = usage?.percent != null ? `${usage.percent.toFixed(1)}% of ${usage.contextWindow}` : "n/a";
				const busy = state.session.isIdle ? "idle" : "working";
				await reply(
					`**Status**\nsession: \`${state.session.sessionId}\`\nmodel: ${model}\nthinking: ${think}\ncontext: ${ctxLine}\nstate: ${busy}`,
				);
				return;
			}

			case "thinking": {
				const state = await ensureChatSession(target);
				if (!arg) {
					await reply(
						`Current thinking level: **${state.session.thinkingLevel}**.\nUsage: \`/thinking <off|minimal|low|medium|high|xhigh|max>\``,
					);
					return;
				}
				const level = parseThinkingLevel(arg);
				if (!level) {
					await reply(`Unknown thinking level "${arg}". Valid: off, minimal, low, medium, high, xhigh, max.`);
					return;
				}
				try {
					state.session.setThinkingLevel(level);
					await reply(`Thinking level set to **${level}**.`);
				} catch (err) {
					await reply(`Failed to set thinking level: ${(err as Error).message}`);
				}
				return;
			}

			case "model": {
				const state = await ensureChatSession(target);
				const models = await getAvailableModels(agentDir);
				if (!arg) {
					await reply(formatModelList(models, state.session.model?.id));
					return;
				}
				const match = matchModel(arg, models);
				if (match.kind === "none") {
					await reply(`No model matches "${arg}". Send \`/model\` to list available models.`);
					return;
				}
				if (match.kind === "ambiguous") {
					const names = match.matches.slice(0, 10).map((m) => `\`${m.id}\``).join(", ");
					await reply(`"${arg}" matches multiple models: ${names}. Be more specific.`);
					return;
				}
				const selected = models.find(
					(model) => model.id === match.model.id && model.provider === match.model.provider,
				);
				if (!selected) {
					await reply(`Model "${match.model.id}" is no longer available.`);
					return;
				}
				try {
					await state.session.setModel(selected.actual as never);
					await reply(`Model switched to **${selected.name}** (\`${selected.id}\`).`);
				} catch (err) {
					await reply(`Failed to switch model: ${(err as Error).message}`);
				}
				return;
			}

			case "clear":
			case "new":
			case "reset": {
				const fresh = await ensureChatSession(target, { reset: true });
				await reply(`Started a fresh session for this chat.\nsession: \`${fresh.session.sessionId}\``);
				return;
			}

			default:
				await reply(`Unknown command \`/${name}\`. Send \`/help\` for the list.`);
				return;
		}
	}

	function onCardAction(ev: CardActionEvent): void {
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
				buildResolvedCard(approved ? "Approved" : "Denied", approved ? "green" : "red"),
			);
		}
		cardTokens.set(token, { state: "completed", at: Date.now() });
		pending.resolve(approved);
	}

	function onInbound(ev: InboundMessageEvent): void {
		if (!cfg || !client || !contextRef) return;

		const normalized = normalizeInbound({
			messageType: ev.messageType,
			content: ev.content,
			mentions: ev.mentions,
			botOpenId: client.botOpenId,
			botName: client.botName,
		});

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
			release?.();
			return;
		}

		const isPlainText = ev.messageType === "text" && normalized.media.length === 0;
		if (isPlainText) {
			const parsed = parseCommand(normalized.text);
			if (parsed) {
				commit?.();
				const target: BoundChat = { chatId: ev.chatId, chatType: ev.chatType, lastMessageId: ev.messageId };
				void runChatCommand(target, parsed.name, parsed.arg);
				return;
			}
		}

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

	async function connectWith(resolved: FeishuConfig, ctx: ExtensionContext): Promise<boolean> {
		cfg = resolved;
		client = new FeishuClient(resolved, log);
		ensureStoreLoaded(ctx.cwd);

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
			if (ctx.hasUI) ctx.ui.setStatus("feishu", "Feishu");
			return true;
		} catch (err) {
			log(`connect failed: ${(err as Error).message}`);
			if (ctx.hasUI) ctx.ui.notify(`Feishu channel connect failed: ${(err as Error).message}`, "error");
			client = undefined;
			cfg = undefined;
			return false;
		}
	}

	async function attemptOnboarding(
		ctx: ExtensionContext,
		domain: "feishu" | "lark",
		credentialsPath: string,
	): Promise<boolean> {
		if (started) return true;
		try {
			log("starting QR onboarding");
			if (ctx.hasUI) ctx.ui.notify("Feishu: scan the QR code in your terminal to log in", "info");
			const result = await runQrOnboarding({ domain, log, out: (t) => process.stdout.write(t) });
			const saved = saveCredentials(credentialsPath, result);
			log(`credentials saved to ${saved}`);
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

	pi.on("session_start", async (_event, ctx) => {
		contextRef = ctx;
		if (started) return;

		const configPathFlag = (pi.getFlag("feishu-config") as string | undefined) || undefined;
		const result = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), configPathFlag });
		ensureStoreLoaded(ctx.cwd);

		const interactive = process.stdout.isTTY === true;
		const onboardingAllowed = result.config ? result.config.onboarding : result.needsOnboarding !== false;

		if (result.config) {
			const ok = await connectWith(result.config, ctx);
			if (ok) return;
			if (interactive && onboardingAllowed) {
				log("configured credentials failed; falling back to QR onboarding");
				await attemptOnboarding(ctx, result.domain ?? result.config.domain, result.credentialsPath ?? "");
			}
			return;
		}

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

	pi.registerCommand("feishu-status", {
		description: "Show Feishu channel status and recent log lines",
		handler: async (_args, ctx) => {
			const status = started ? "connected" : "not connected";
			const feats = cfg
				? `stream=${cfg.streaming} card=${cfg.staticCard} react=${cfg.reactEnabled} dedup=${cfg.dedupEnabled} debounce=${cfg.debounceEnabled} queue=${cfg.queueEnabled} approval=${cfg.approvalEnabled}`
				: "(no config)";
			const sessionRows =
				[...chatSessions.values()]
					.slice(0, 8)
					.map((state) => `- ${state.chatId}: ${state.session.sessionId} (${state.session.isIdle ? "idle" : "working"})`)
					.join("\n") || "(no live chat sessions)";
			const recent = logLines.slice(-8).join("\n") || "(no log lines yet)";
			ctx.ui.notify(
				`Feishu: ${status}; chats=${chatSessions.size}; ${feats}\n${sessionRows}\n${recent}`,
				"info",
			);
		},
	});

	pi.registerCommand("feishu-login", {
		description: "Scan a QR code to create or select a Feishu bot, then connect (prints QR to terminal)",
		handler: async (args, ctx) => {
			if (started) {
				ctx.ui.notify("Feishu channel is already connected. Use /feishu-status.", "info");
				return;
			}
			const configPathFlag = (pi.getFlag("feishu-config") as string | undefined) || undefined;
			const result = loadConfig({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), configPathFlag });
			const domain: "feishu" | "lark" = args.trim().toLowerCase() === "lark" ? "lark" : result.domain ?? "feishu";
			const credentialsPath = result.credentialsPath ?? "";
			ctx.ui.notify("Feishu QR login started - check your terminal for the QR code.", "info");
			const ok = await attemptOnboarding(ctx, domain, credentialsPath);
			ctx.ui.notify(ok ? "Feishu connected." : "Feishu login did not complete (see logs).", ok ? "info" : "warning");
		},
	});

	pi.on("session_shutdown", async () => {
		if (sweepTimer) clearInterval(sweepTimer);
		sweepTimer = undefined;

		debouncer?.flushAll();
		for (const state of [...chatSessions.values()]) {
			await disposeChatSession(state);
		}

		for (const [, pending] of pendingApprovals) {
			clearTimeout(pending.timer);
			pending.resolve(false);
		}
		pendingApprovals.clear();
		cardTokens.clear();
		saveStore();

		await client?.disconnect();
		client = undefined;
		cfg = undefined;
		deduper = undefined;
		debouncer = undefined;
		queue = undefined;
		started = false;
		log("disconnected");
	});
}
