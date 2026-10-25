/**
 * FileApiKeyStore：与 pi auth.json 同格式的凭证存储（CredentialStore 实现）。
 * pi 的 ModelRuntime 默认文件存储不随 setRuntimeApiKey 落盘（那是运行时覆盖），
 * 持久化由宿主负责——本实现按 pi 的 Credential 契约写入 auth.json，
 * 与 pi CLI 生态的文件格式保持兼容。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	AuthOperationOptions,
	Credential,
	CredentialInfo,
	CredentialStore,
} from "@earendil-works/pi-ai";

export interface CredentialCipher {
	/** 明文 JSON 文本 → 落盘文本 */
	encrypt(plain: string): string;
	/** 落盘文本 → 明文 JSON 文本（无法解密时抛错） */
	decrypt(stored: string): string;
	/** 落盘内容是否为该 cipher 的密文格式 */
	isEncrypted(stored: string): boolean;
}

export class FileApiKeyStore implements CredentialStore {
	#path: string;
	#data: Record<string, Credential> = {};
	#chain: Promise<unknown> = Promise.resolve();
	#cipher: CredentialCipher | null;

	constructor(path: string, opts: { cipher?: CredentialCipher | null } = {}) {
		this.#path = path;
		this.#cipher = opts.cipher ?? null;
		if (existsSync(path)) {
			const raw = readFileSync(path, "utf8");
			try {
				const text = this.#cipher && this.#cipher.isEncrypted(raw) ? this.#cipher.decrypt(raw) : raw;
				this.#data = JSON.parse(text) as Record<string, Credential>;
				// 明文旧文件 + 加密可用 → 立即加密重写（迁移）
				if (this.#cipher && !this.#cipher.isEncrypted(raw) && Object.keys(this.#data).length > 0) {
					this.#save();
				}
			} catch {
				this.#data = {};
			}
		}
	}

	read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		return Promise.resolve(this.#data[providerId]);
	}

	list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		return Promise.resolve(
			Object.entries(this.#data).map(([providerId, c]) => ({ providerId, type: c.type })),
		);
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		_options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		const run = async (): Promise<Credential | undefined> => {
			const next = await fn(this.#data[providerId]);
			if (next) this.#data[providerId] = next;
			else delete this.#data[providerId];
			this.#save();
			return next;
		};
		this.#chain = this.#chain.then(run, run);
		return this.#chain as Promise<Credential | undefined>;
	}

	delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		const run = async (): Promise<void> => {
			delete this.#data[providerId];
			this.#save();
		};
		this.#chain = this.#chain.then(run, run);
		return this.#chain as Promise<void>;
	}

	#save(): void {
		mkdirSync(dirname(this.#path), { recursive: true });
		const plain = JSON.stringify(this.#data, null, "\t");
		writeFileSync(this.#path, this.#cipher ? this.#cipher.encrypt(plain) : plain, "utf8");
	}
}
