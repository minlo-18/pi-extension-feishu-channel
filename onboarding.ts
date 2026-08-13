/**
 * QR-code onboarding: scan to create or select a Feishu bot, then get its
 * credentials back — no manual App ID / App Secret copy-paste.
 *
 * Uses the official SDK's `registerApp(...)` (the "scan-to-create-or-select"
 * device-code flow). It returns a QR **url**; we render that url as a terminal
 * QR (via the `qrcode` package if available, else print the url) so the
 * operator can scan it in the Feishu / Lark mobile app. `registerApp` then
 * polls internally and resolves with `{ client_id, client_secret, user_info }`.
 *
 * `addons` pre-fills the IM permission scopes / event subscriptions / callbacks
 * the confirm page shows, so the created (or selected) app is immediately able
 * to receive `im.message.receive_v1` + `card.action.trigger` and send messages.
 * (Additive only — it never removes base permissions; the user confirms on the
 * page.) When the user SELECTS an existing app instead of creating one, the
 * scopes still need to already be granted on that app.
 *
 * openclaw / hermes hand-roll this device-code flow against
 * accounts.feishu.cn/oauth/v1/app/registration; the Node SDK ships the same
 * flow as `registerApp`, so we use the official function instead of re-deriving
 * the raw endpoint.
 */

import type { OnboardingResult } from "./config.ts";

/** IM scopes/events/callbacks pre-filled on the scan confirm page. */
const IM_ADDONS = {
	// Keep the platform default template and layer these on top (additive).
	preset: true,
	scopes: {
		tenant: [
			"im:message", // read/receive messages
			"im:message:send_as_bot", // send messages as the bot
			"im:message.group_at_msg", // receive @bot in groups
			"im:message.group_at_msg:readonly",
			"im:message.p2p_msg", // receive DMs
			"im:message.p2p_msg:readonly",
			"im:resource", // download inbound media (image/file/audio/video)
			"im:chat:readonly", // read chat metadata
		],
	},
	events: {
		items: {
			tenant: ["im.message.receive_v1"],
		},
	},
	callbacks: {
		items: ["card.action.trigger"], // interactive card button clicks (approval)
	},
};

export interface OnboardingOptions {
	/** "feishu" (China) or "lark" (International). Controls the accounts host. */
	domain: "feishu" | "lark";
	/** Optional bot name/desc pre-fill shown on the creation page. */
	appName?: string;
	appDesc?: string;
	/** Only allow creating a NEW app (hide "select existing"). Default false. */
	createOnly?: boolean;
	/** Update an existing app's config instead of creating a new one. */
	appId?: string;
	/** Abort the flow (e.g. on shutdown). */
	signal?: AbortSignal;
	log?: (msg: string) => void;
	/** Where to print the QR / instructions. Defaults to process.stdout. */
	out?: (text: string) => void;
}

/**
 * Render `url` as a scannable QR to the terminal. Uses the `qrcode` package's
 * compact half-block output when available; otherwise prints the raw url so the
 * user can open it manually. Never throws.
 */
async function renderQr(url: string, out: (text: string) => void): Promise<void> {
	try {
		const qrcode = await import("qrcode");
		// `toString` with type "terminal" + small=true yields compact half-block art.
		const art = await qrcode.toString(url, { type: "terminal", small: true });
		out(`${art}\n`);
	} catch {
		out(
			"\n（未检测到 qrcode 渲染库，请在浏览器/飞书App中打开下面的链接完成扫码授权）\n" +
				"(qrcode renderer unavailable — open this URL in the Feishu/Lark app to authorize)\n",
		);
	}
	// Always print the URL as well, so a non-scannable terminal still works.
	out(`\n${url}\n`);
}

/**
 * Run the QR onboarding flow. Resolves with credentials on success, or rejects
 * with an Error (`.message` carries access_denied / expired_token / timeout).
 */
export async function runQrOnboarding(options: OnboardingOptions): Promise<OnboardingResult> {
	const log = options.log ?? (() => {});
	const out = options.out ?? ((t: string) => process.stdout.write(t));

	let lark: typeof import("@larksuiteoapi/node-sdk");
	try {
		lark = await import("@larksuiteoapi/node-sdk");
	} catch (err) {
		throw new Error(
			"@larksuiteoapi/node-sdk is not installed. Run `npm install` inside the " +
				`feishu-channel extension directory. (${(err as Error).message})`,
		);
	}
	if (typeof (lark as { registerApp?: unknown }).registerApp !== "function") {
		throw new Error(
			"This @larksuiteoapi/node-sdk version has no registerApp(); QR onboarding needs >= 1.53. " +
				"Upgrade the dependency, or set FEISHU_APP_ID / FEISHU_APP_SECRET manually.",
		);
	}

	const appPreset =
		options.appName || options.appDesc
			? { name: options.appName, desc: options.appDesc }
			: undefined;

	out("\n🪽  飞书扫码登录 / Feishu QR login\n请用飞书手机 App 扫描下方二维码，选择或创建一个机器人：\nScan the QR below in the Feishu/Lark mobile app, then select or create a bot.\n");

	const result = await lark.registerApp({
		// `domain` is the accounts HOST (not the Domain enum). Undefined defaults
		// to accounts.feishu.cn; the SDK auto-switches to Lark on tenant_brand.
		domain: options.domain === "lark" ? "accounts.larksuite.com" : undefined,
		source: "pi-extension-feishu-channel",
		signal: options.signal,
		appPreset,
		addons: IM_ADDONS,
		createOnly: options.createOnly,
		appId: options.appId,
		onQRCodeReady: (info: { url: string; expireIn: number }) => {
			log(`QR ready (expires in ${info.expireIn}s)`);
			void renderQr(info.url, out);
			out(`\n（二维码 ${info.expireIn} 秒内有效 / valid for ${info.expireIn}s）\n`);
		},
		onStatusChange: (info: { status: string; interval?: number }) => {
			if (info.status === "polling") log("waiting for scan / confirmation…");
			else if (info.status === "slow_down") log(`slow down, polling every ${info.interval ?? "?"}s`);
			else if (info.status === "domain_switched") log("switched to Lark (International) domain");
		},
	});

	const openId = result.user_info?.open_id;
	const resolvedDomain =
		result.user_info?.tenant_brand === "lark" ? "lark" : options.domain;

	log(`onboarding success (open_id=${openId ?? "?"}, domain=${resolvedDomain})`);
	out("\n✅ 授权成功，已获取机器人凭证 / credentials acquired.\n");

	return {
		appId: result.client_id,
		appSecret: result.client_secret,
		domain: resolvedDomain,
		openId,
	};
}
