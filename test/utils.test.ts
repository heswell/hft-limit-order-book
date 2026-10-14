import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { randomUUID, safeParse, safeStringify } from "../src/utils";

describe("safeStringify", () => {
	test("should stringify a valid object", () => {
		const obj = { name: "Alice", age: 25 };
		const result = safeStringify(obj);
		assert.strictEqual(result, JSON.stringify(obj));
	});

	test("should return null for objects with circular references", () => {
		const obj = {};
		// @ts-expect-error self does not exist on {}
		obj.self = obj; // Riferimento circolare
		const result = safeStringify(obj);
		assert.strictEqual(result, null);
	});

	test("should handle non-object values gracefully", () => {
		const result = safeStringify(null);
		assert.strictEqual(result, JSON.stringify(null));
	});

	test("should handle arrays correctly", () => {
		const arr = [1, 2, 3];
		const result = safeStringify(arr);
		assert.strictEqual(result, JSON.stringify(arr));
	});
});

describe("safeParse", () => {
	test("should parse a valid JSON string", () => {
		const jsonStr = '{"name":"Alice","age":25}';
		const result = safeParse(jsonStr);
		assert.deepStrictEqual(result, { name: "Alice", age: 25 });
	});

	test("should return null for invalid JSON strings", () => {
		const invalidJson = '{name:"Alice",age:25}'; // JSON non valido
		const result = safeParse(invalidJson);
		assert.strictEqual(result, null);
	});

	test("should handle an empty string gracefully", () => {
		const result = safeParse("");
		assert.strictEqual(result, null);
	});

	test("should handle JSON strings representing non-object types", () => {
		const jsonStr = '"hello"'; // Stringa valida in JSON
		const result = safeParse(jsonStr);
		assert.strictEqual(result, "hello");
	});

	test("should handle arrays correctly", () => {
		const jsonStr = "[1,2,3]";
		const result = safeParse(jsonStr);
		assert.deepStrictEqual(result, [1, 2, 3]);
	});
});

describe("randomUUID", () => {
	const UUID_V4 =
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

	test("uses globalThis.crypto.randomUUID when available", (t) => {
		const mock = t.mock.method(globalThis.crypto, "randomUUID");
		assert.match(randomUUID(), UUID_V4);
		assert.equal(mock.mock.callCount(), 1);
	});

	// globalThis.crypto is a getter in Node, so swap the property descriptor
	const withCrypto = (
		t: { after: (fn: () => void) => void },
		value: unknown,
	): void => {
		const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
		Object.defineProperty(globalThis, "crypto", {
			value,
			configurable: true,
			writable: true,
		});
		t.after(() => {
			if (original) Object.defineProperty(globalThis, "crypto", original);
		});
	};

	test("falls back to getRandomValues without randomUUID", (t) => {
		const getRandomValues = globalThis.crypto.getRandomValues.bind(
			globalThis.crypto,
		);
		withCrypto(t, { getRandomValues });
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const id = randomUUID();
			assert.match(id, UUID_V4);
			ids.add(id);
		}
		assert.equal(ids.size, 100);
	});

	test("falls back to Math.random without Web Crypto", (t) => {
		withCrypto(t, undefined);
		assert.match(randomUUID(), UUID_V4);
		assert.notEqual(randomUUID(), randomUUID());
	});
});
