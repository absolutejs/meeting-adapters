/**
 * Bun-compile helper for the DAVE/MLS native binary.
 *
 * `@discordjs/voice` >= 0.18 depends on `@snazzah/davey`, a NAPI native addon
 * that ships per-platform prebuilt `.node` files (linux-x64-gnu, linux-x64-
 * musl, darwin-arm64, …). In a Bun dev process those resolve fine via
 * node_modules at runtime; in a `bun build --compile` self-contained
 * executable they don't — Bun's bundler only embeds `.node` files it can
 * statically see in the import graph, and davey's loader hides the actual
 * `require()` behind a runtime platform-detection chain wrapped in try/catch.
 *
 * The fix is two lines + one upstream patch:
 *
 *  1. `import path from "@snazzah/davey-<target>/davey.<target>.node" with
 *     { type: "file" }` — Bun's documented file-embed import attribute,
 *     which copies the `.node` into the bunfs at compile time and resolves
 *     to a runtime path. (`process.dlopen` later extracts it to a tmpdir
 *     and loads it; nothing to ship alongside the binary.)
 *
 *  2. Resolve that path against `import.meta.url` — Bun returns a *relative*
 *     path like `./davey-abc.node`, and davey's `require()` resolves
 *     relative paths against the caller's file, not cwd, so the file isn't
 *     found unless we resolve to absolute first.
 *
 *  3. `process.env.NAPI_RS_NATIVE_LIBRARY_PATH = absolute` — napi-rs's
 *     documented escape hatch that short-circuits its platform-detection
 *     chain to load that exact file.
 *
 *  4. **Patch `@snazzah/davey`** to actually return the env-var path. The
 *     loader currently assigns to a `nativeBinding` outer var but the
 *     enclosing `requireNative()` doesn't `return`, so `nativeBinding =
 *     requireNative()` overwrites with `undefined` and the load silently
 *     fails. Ship a `patches/@snazzah%2Fdavey@X.Y.Z.patch` in your app and
 *     reference it under `patchedDependencies` in package.json — `bun
 *     install` applies it everywhere automatically. (Upstream PR-able fix.)
 *
 * Side-effect import — there's nothing to call. The env var is set the
 * moment the module loads, so this MUST be imported BEFORE any module that
 * triggers `@discordjs/voice` (which transitively triggers davey). Put it at
 * the top of your app's entry point, alongside other early side-effect
 * imports (sentry, logging).
 *
 *     import "@absolutejs/meeting-discord/compile";
 *     // ... rest of the app
 *
 * Targets a single platform — pick the one your compile target uses. To
 * support more, fork this file. Defaults to linux-x64-gnu since that's what
 * the typical Docker / DigitalOcean / Fly base image runs.
 *
 * Refs:
 *   - https://bun.com/blog/bun-v1.0.23 (Bun .node embedding)
 *   - https://bun.com/docs/bundler/executables (must-be-directly-required)
 *   - napi-rs binding.js (NAPI_RS_NATIVE_LIBRARY_PATH override)
 */
import { fileURLToPath } from "node:url";
import nativePath from "@snazzah/davey-linux-x64-gnu/davey.linux-x64-gnu.node" with {
  type: "file",
};

// `with { type: "file" }` returns a path that is RELATIVE to the bundle
// (e.g. `./davey.linux-x64-gnu-vevevdy2.node`). davey's loader does a bare
// `__require(NAPI_RS_NATIVE_LIBRARY_PATH)` — and `require()` against a bare
// relative path resolves against the caller's cwd, not the bundle, so it
// can't find the file. Resolve against this module's URL to get an absolute
// path that works regardless of cwd, in both `bun run` (path is in dist/)
// and `bun --compile` (path is in the bunfs).
const resolved = (() => {
  try {
    return fileURLToPath(new URL(nativePath as unknown as string, import.meta.url));
  } catch {
    return nativePath as unknown as string;
  }
})();

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = resolved;
