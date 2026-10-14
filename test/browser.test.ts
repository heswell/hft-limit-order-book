import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";

const nodeBuiltins = new Set(
	builtinModules.flatMap((m) => [m, `node:${m}`, m.split("/")[0]]),
);

// Bundles the public entry for the browser, the way rspack/webpack/vite users
// consume the package, and fails on any Node-only import.
void test("browser bundle of the entry point has no node: or builtin imports", async () => {
	const result = await build({
		entryPoints: [resolve(import.meta.dirname, "../src/index.ts")],
		bundle: true,
		platform: "browser",
		format: "esm",
		write: false,
		metafile: true,
		logLevel: "silent",
	});
	assert.equal(result.errors.length, 0);
	const imports = Object.values(result.metafile.inputs).flatMap((input) =>
		input.imports.map((i) => i.path),
	);
	const offending = imports.filter(
		(p) => p.startsWith("node:") || nodeBuiltins.has(p),
	);
	assert.deepEqual(offending, []);
	const code = result.outputFiles[0].text;
	assert.doesNotMatch(code, /["']node:[a-z_/]+["']/);
	assert.doesNotMatch(code, /\brequire\(/);
});
