/* node:coverage ignore next - Don't know why this line is uncovered */
export const safeStringify = (value: unknown): string | null => {
	try {
		return JSON.stringify(value);
	} catch (_error) {
		return null;
	}
};

/* node:coverage ignore next - Don't know why this line is uncovered */
export const safeParse = <T>(value: string): T | null => {
	try {
		return JSON.parse(value);
	} catch (_error) {
		return null;
	}
};

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push((i + 0x100).toString(16).slice(1));

/**
 * RFC 4122 v4 UUID without importing the Node crypto module, so the library can be
 * bundled for browsers. Uses `globalThis.crypto` (Node >= 19, Bun, Deno and
 * browsers) and falls back to `Math.random` where Web Crypto is missing.
 */
export const randomUUID = (): string => {
	const webCrypto = (globalThis as { crypto?: Partial<Crypto> }).crypto;
	if (typeof webCrypto?.randomUUID === "function") {
		return webCrypto.randomUUID();
	}
	const bytes = new Uint8Array(16);
	if (typeof webCrypto?.getRandomValues === "function") {
		webCrypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	let s = "";
	for (let i = 0; i < 16; i++) {
		if (i === 4 || i === 6 || i === 8 || i === 10) s += "-";
		s += HEX[bytes[i]];
	}
	return s;
};
