/**
 * Thin wrapper around @larksuiteoapi/node-sdk providing:
 *   - a WebSocket long-connection to receive `im.message.receive_v1` and
 *     `card.action.trigger` events
 *   - message send / reply helpers (text, post, interactive card)
 *   - media upload (image/file) and download (message resource)
 *   - bot identity hydration (open_id + name) for @mention detection
 *
 * Design mirrors hermes-agent's FeishuAdapter connect/send/hydrate/media paths,
 * but uses the official Node SDK (in-process, no external binary), which is the
 * TypeScript equivalent of the Go SDK that lark-cli wraps.
 *
 * The SDK is imported lazily (dynamic import) so that merely loading the
 * extension — which happens on every pi invocation — does not pull in the
 * heavy SDK or fail when it isn't installed yet.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { FeishuConfig } from "./config.ts";
import type { FeishuMention, MediaKind } from "./message.ts";

/** Shape of the inbound `im.message.receive_v1` event we care about. */
export interface InboundMessageEvent {
	messageId: string;
	chatId: string;
	chatType: string; // "p2p" | "group"
	messageType: string;
	content: string;
	senderOpenId?: string;
	senderType?: string; // "user" | "app" | ...
	mentions: FeishuMention[];
	createTime?: string;
}

/** Shape of the inbound `card.action.trigger` event we care about. */
export interface CardActionEvent {
	messageId: string;
	chatId: string;
	operatorOpenId: string;
	value: Record<string, unknown>;
}

export type InboundHandler = (event: InboundMessageEvent) => void;
export type CardActionHandler = (event: CardActionEvent) => void;

/** A downloaded resource written to a local path. */
export interface DownloadedResource {
	kind: MediaKind;
	localPath: string;
	fileName: string;
}

// Minimal structural types for the parts of the SDK we touch. We avoid a hard
// compile-time dependency so the extension type-checks even before `npm i`.
interface ResourceDownload {
	writeFile: (filePath: string) => Promise<unknown>;
	getReadableStream: () => NodeJS.ReadableStream;
}
interface MessageResource {
	create: (args: unknown) => Promise<unknown>;
	reply: (args: unknown) => Promise<unknown>;
}
interface ImageResource {
	create: (args: unknown) => Promise<{ image_key?: string } | null>;
}
interface FileResource {
	create: (args: unknown) => Promise<{ file_key?: string } | null>;
	get: (args: unknown) => Promise<ResourceDownload>;
}
interface MessageResourceApi {
	get: (args: unknown) => Promise<ResourceDownload>;
}
interface LarkImNamespace {
	message?: MessageResource;
	image?: ImageResource;
	file?: FileResource;
	messageResource?: MessageResourceApi;
	v1?: {
		message: MessageResource;
		image: ImageResource;
		file: FileResource;
		messageResource: MessageResourceApi;
	};
}
interface CardApi {
	create: (args: unknown) => Promise<{ code?: number; data?: { card_id?: string } } | null>;
	settings: (args: unknown) => Promise<unknown>;
	update: (args: unknown) => Promise<unknown>;
}
interface CardElementApi {
	content: (args: unknown) => Promise<unknown>;
}
interface CardKitNamespace {
	v1?: { card: CardApi; cardElement: CardElementApi };
	card?: CardApi;
	cardElement?: CardElementApi;
}
interface LarkClientLike {
	im: LarkImNamespace;
	cardkit?: CardKitNamespace;
	request: (req: unknown) => Promise<unknown>;
}
interface WSClientLike {
	start: (args: { eventDispatcher: unknown }) => void;
	stop?: () => void;
}

export class FeishuClient {
	private cfg: FeishuConfig;
	private lark: any;
	private client!: LarkClientLike;
	private wsClient?: WSClientLike;
	private log: (msg: string) => void;

	botOpenId?: string;
	botName?: string;

	constructor(cfg: FeishuConfig, log: (msg: string) => void = () => {}) {
		this.cfg = cfg;
		this.log = log;
		this.botOpenId = cfg.botOpenId;
		this.botName = cfg.botName;
	}

	/** Dynamically load the SDK and build the API client. */
	private async ensureLoaded(): Promise<void> {
		if (this.lark) return;
		try {
			this.lark = await import("@larksuiteoapi/node-sdk");
		} catch (err) {
			throw new Error(
				"@larksuiteoapi/node-sdk is not installed. Run `npm install` inside the " +
					`feishu-channel extension directory. (${(err as Error).message})`,
			);
		}
		const domain = this.cfg.domain === "lark" ? this.lark.Domain.Lark : this.lark.Domain.Feishu;
		this.client = new this.lark.Client({
			appId: this.cfg.appId,
			appSecret: this.cfg.appSecret,
			appType: this.lark.AppType.SelfBuild,
			domain,
		}) as LarkClientLike;
	}

	private messageResource(): MessageResource {
		// SDK exposes `client.im.v1.message` (newer) or `client.im.message` (older).
		return (this.client.im.v1?.message ?? this.client.im.message) as MessageResource;
	}
	private imageResource(): ImageResource {
		return (this.client.im.v1?.image ?? this.client.im.image) as ImageResource;
	}
	private fileResource(): FileResource {
		return (this.client.im.v1?.file ?? this.client.im.file) as FileResource;
	}
	private messageResourceApi(): MessageResourceApi {
		return (this.client.im.v1?.messageResource ?? this.client.im.messageResource) as MessageResourceApi;
	}
	private cardApi(): CardApi | undefined {
		return this.client.cardkit?.v1?.card ?? this.client.cardkit?.card;
	}
	private cardElementApi(): CardElementApi | undefined {
		return this.client.cardkit?.v1?.cardElement ?? this.client.cardkit?.cardElement;
	}

	/** Whether the loaded SDK exposes the CardKit streaming API. */
	async supportsCardKit(): Promise<boolean> {
		await this.ensureLoaded();
		return Boolean(this.cardApi() && this.cardElementApi());
	}

	/**
	 * Create a CardKit card entity from a schema-2.0 card JSON string.
	 * Returns the card_id used for subsequent streaming updates.
	 */
	async createCardEntity(cardJson: string): Promise<string | undefined> {
		await this.ensureLoaded();
		const api = this.cardApi();
		if (!api) return undefined;
		const resp = await api.create({ data: { type: "card_json", data: cardJson } });
		return resp?.data?.card_id;
	}

	/** Stream a full-text snapshot into a card's markdown element. */
	async streamCardContent(cardId: string, elementId: string, content: string, sequence: number, uuid: string): Promise<void> {
		await this.ensureLoaded();
		const api = this.cardElementApi();
		if (!api) return;
		await api.content({ path: { card_id: cardId, element_id: elementId }, data: { content, sequence, uuid } });
	}

	/** Toggle a card's streaming_mode / settings (used to finalize a stream). */
	async patchCardSettings(cardId: string, settings: string, sequence: number): Promise<void> {
		await this.ensureLoaded();
		const api = this.cardApi();
		if (!api) return;
		await api.settings({ path: { card_id: cardId }, data: { settings, sequence } });
	}

	/** Send a previously-created card entity to a chat; returns message_id. */
	async sendCardEntity(chatId: string, cardId: string): Promise<string | undefined> {
		await this.ensureLoaded();
		const resp: any = await this.messageResource().create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, msg_type: "interactive", content: JSON.stringify({ type: "card", data: { card_id: cardId } }) },
		});
		return resp?.data?.message_id ?? resp?.message_id;
	}

	/** Reply (threaded) with a previously-created card entity; returns message_id. */
	async replyCardEntity(messageId: string, cardId: string, replyInThread = false): Promise<string | undefined> {
		await this.ensureLoaded();
		const resp: any = await this.messageResource().reply({
			path: { message_id: messageId },
			data: {
				msg_type: "interactive",
				content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
				reply_in_thread: replyInThread,
			},
		});
		return resp?.data?.message_id ?? resp?.message_id;
	}

	/**
	 * Resolve the bot's own open_id + name via /open-apis/bot/v3/info so that
	 * @mention detection is reliable. Best effort — failures are non-fatal.
	 */
	async hydrateBotIdentity(): Promise<void> {
		if (this.botOpenId && this.botName) return;
		await this.ensureLoaded();
		try {
			const resp: any = await this.client.request({
				method: "GET",
				url: "/open-apis/bot/v3/info",
			});
			const bot = resp?.bot ?? resp?.data?.bot ?? resp;
			if (bot?.open_id && !this.botOpenId) this.botOpenId = bot.open_id;
			if (bot?.app_name && !this.botName) this.botName = bot.app_name;
			this.log(`bot identity: open_id=${this.botOpenId ?? "?"} name=${this.botName ?? "?"}`);
		} catch (err) {
			this.log(`bot identity hydration failed (non-fatal): ${(err as Error).message}`);
		}
	}

	/**
	 * Open the WebSocket long-connection. Routes inbound IM messages to
	 * `onMessage` and interactive-card clicks to `onCardAction`.
	 */
	async connect(onMessage: InboundHandler, onCardAction?: CardActionHandler): Promise<void> {
		await this.ensureLoaded();

		const handlers: Record<string, (data: any) => Promise<unknown> | unknown> = {
			"im.message.receive_v1": async (data: any) => {
				try {
					const msg = data?.message ?? {};
					const sender = data?.sender ?? {};
					const mentions: FeishuMention[] = Array.isArray(msg.mentions) ? msg.mentions : [];
					onMessage({
						messageId: msg.message_id ?? "",
						chatId: msg.chat_id ?? "",
						chatType: msg.chat_type ?? "",
						messageType: msg.message_type ?? "",
						content: msg.content ?? "{}",
						senderOpenId: sender?.sender_id?.open_id,
						senderType: sender?.sender_type,
						mentions,
						createTime: msg.create_time,
					});
				} catch (err) {
					this.log(`inbound dispatch error: ${(err as Error).message}`);
				}
			},
		};

		if (onCardAction) {
			handlers["card.action.trigger"] = async (raw: any) => {
				try {
					const ctx = raw?.event ?? raw;
					const messageId = ctx?.context?.open_message_id ?? ctx?.open_message_id ?? "";
					const chatId = ctx?.context?.open_chat_id ?? ctx?.open_chat_id ?? "";
					const operatorOpenId = ctx?.operator?.open_id ?? "";
					const value = (ctx?.action?.value ?? {}) as Record<string, unknown>;
					onCardAction({ messageId, chatId, operatorOpenId, value });
				} catch (err) {
					this.log(`card action dispatch error: ${(err as Error).message}`);
				}
				// Returning nothing leaves the card unchanged; we swap it via update.
				return;
			};
		}

		const dispatcher = new this.lark.EventDispatcher({}).register(handlers);

		this.wsClient = new this.lark.WSClient({
			appId: this.cfg.appId,
			appSecret: this.cfg.appSecret,
			domain: this.cfg.domain === "lark" ? this.lark.Domain.Lark : this.lark.Domain.Feishu,
			loggerLevel: this.lark.LoggerLevel?.warn,
		}) as WSClientLike;

		this.wsClient.start({ eventDispatcher: dispatcher });
		this.log("WebSocket long-connection started");
	}

	/** Close the long-connection. Idempotent. */
	async disconnect(): Promise<void> {
		try {
			this.wsClient?.stop?.();
		} catch (err) {
			this.log(`disconnect error (ignored): ${(err as Error).message}`);
		}
		this.wsClient = undefined;
	}

	/** Send a new message to a chat. */
	async sendToChat(chatId: string, msgType: string, content: string): Promise<void> {
		await this.ensureLoaded();
		await this.messageResource().create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, msg_type: msgType, content },
		});
	}

	/** Reply (threaded) to a specific message. */
	async replyToMessage(messageId: string, msgType: string, content: string): Promise<void> {
		await this.ensureLoaded();
		await this.messageResource().reply({
			path: { message_id: messageId },
			data: { msg_type: msgType, content },
		});
	}

	/** Send an interactive card to a chat; returns the created message_id. */
	async sendCard(chatId: string, cardJson: string): Promise<string | undefined> {
		await this.ensureLoaded();
		const resp: any = await this.messageResource().create({
			params: { receive_id_type: "chat_id" },
			data: { receive_id: chatId, msg_type: "interactive", content: cardJson },
		});
		return resp?.data?.message_id ?? resp?.message_id;
	}

	/** Replace the content of an already-sent card message. */
	async updateCard(messageId: string, cardJson: string): Promise<void> {
		await this.ensureLoaded();
		const resource = this.messageResource() as MessageResource & {
			patch?: (args: unknown) => Promise<unknown>;
		};
		if (typeof resource.patch === "function") {
			await resource.patch({ path: { message_id: messageId }, data: { content: cardJson } });
		}
	}

	/** Upload a local image; returns its image_key. */
	async uploadImage(localPath: string): Promise<string | undefined> {
		await this.ensureLoaded();
		const resp = await this.imageResource().create({
			data: { image_type: "message", image: fs.createReadStream(localPath) },
		});
		return resp?.image_key;
	}

	/** Upload a local file (audio/video/doc/etc); returns its file_key. */
	async uploadFile(localPath: string, fileType: string, fileName: string): Promise<string | undefined> {
		await this.ensureLoaded();
		const resp = await this.fileResource().create({
			data: { file_type: fileType, file_name: fileName, file: fs.createReadStream(localPath) },
		});
		return resp?.file_key;
	}

	/** Send a previously-uploaded image to a chat. */
	async sendImageKey(chatId: string, imageKey: string): Promise<void> {
		await this.sendToChat(chatId, "image", JSON.stringify({ image_key: imageKey }));
	}

	/** Send a previously-uploaded file to a chat. */
	async sendFileKey(chatId: string, fileKey: string): Promise<void> {
		await this.sendToChat(chatId, "file", JSON.stringify({ file_key: fileKey }));
	}

	/**
	 * Download a resource embedded in an inbound message to `destDir`.
	 * Images are fetched via the image API; other kinds via the message-resource
	 * API (which requires the owning message_id + file_key + a `type` param).
	 */
	async downloadResource(params: {
		kind: MediaKind;
		messageId: string;
		imageKey?: string;
		fileKey?: string;
		fileName?: string;
		destDir: string;
	}): Promise<DownloadedResource | undefined> {
		await this.ensureLoaded();
		const { kind, messageId, imageKey, fileKey, destDir } = params;
		fs.mkdirSync(destDir, { recursive: true });

		try {
			let download: ResourceDownload;
			let fileName: string;

			if (kind === "image" && imageKey) {
				download = await this.messageResourceApi().get({
					path: { message_id: messageId, file_key: imageKey },
					params: { type: "image" },
				});
				fileName = params.fileName ?? `${imageKey}.png`;
			} else if (fileKey) {
				const resourceType = kind === "audio" || kind === "video" ? kind : "file";
				download = await this.messageResourceApi().get({
					path: { message_id: messageId, file_key: fileKey },
					params: { type: resourceType },
				});
				fileName = params.fileName ?? fileKey;
			} else {
				return undefined;
			}

			const safeName = path.basename(fileName).replace(/[^\w.\-]+/g, "_") || "download";
			const localPath = path.join(destDir, `${Date.now()}_${safeName}`);
			await download.writeFile(localPath);
			return { kind, localPath, fileName: safeName };
		} catch (err) {
			this.log(`download resource failed (kind=${kind}): ${(err as Error).message}`);
			return undefined;
		}
	}
}
