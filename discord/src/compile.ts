/**
 * Native assets required when compiling Discord meeting support into a
 * standalone AbsoluteJS executable.
 *
 * Import this metadata from absolute.config.ts and pass it to
 * `compile.nativeAssets`. Absolute injects the actual `with { type: "file" }`
 * imports only during `absolute compile`, so dev/start never evaluate `.node`
 * files as ESM.
 *
 *     import { discordCompileNativeAssets } from "@absolutejs/meeting-discord/compile";
 *
 *     export default defineConfig({
 *       compile: {
 *         nativeAssets: discordCompileNativeAssets,
 *       },
 *     });
 */
export const discordCompileNativeAssets = [
  {
    env: "NAPI_RS_NATIVE_LIBRARY_PATH",
    import: "@snazzah/davey-linux-x64-gnu/davey.linux-x64-gnu.node",
  },
] as const;
