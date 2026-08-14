import * as fs from "node:fs";
import * as path from "node:path";

export const SESSION_STATE_FILE_NAME = "feishu-channel-state.json";
export const SESSION_DIR_NAME = "feishu-sessions";

interface SessionBinding {
	sessionFile: string;
	updatedAt: string;
}

interface SessionStoreFile {
	version: 1;
	chats: Record<string, SessionBinding>;
}

export interface SessionStore {
	chats: Record<string, SessionBinding>;
}

function ensurePiDir(cwd: string): string {
	const dir = path.join(cwd, ".pi");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function getSessionStatePath(cwd: string): string {
	return path.join(ensurePiDir(cwd), SESSION_STATE_FILE_NAME);
}

export function getSessionDir(cwd: string): string {
	const dir = path.join(ensurePiDir(cwd), SESSION_DIR_NAME);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

export function loadSessionStore(cwd: string): SessionStore {
	const filePath = getSessionStatePath(cwd);
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as Partial<SessionStoreFile>;
		const chats = parsed?.chats && typeof parsed.chats === "object" ? parsed.chats : {};
		return { chats };
	} catch {
		return { chats: {} };
	}
}

export function saveSessionStore(cwd: string, store: SessionStore): string {
	const filePath = getSessionStatePath(cwd);
	const payload: SessionStoreFile = {
		version: 1,
		chats: store.chats,
	};
	fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`);
	return filePath;
}
