# Upstream Issues

Bugs in **@absolutejs/meeting-discord's dependencies** that we work around
instead of fixing, each with its symptom, cause, workaround and the upstream
issue to watch. Remove an entry only once a fixed release ships, we've bumped
past it, and the reproduction below **passes**: an issue being closed is not
proof a fix shipped.

| #   | Problem                                                      | Upstream                                                         | Fixed?      |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------- | ----------- |
| 1   | `@snazzah/davey` ignores `NAPI_RS_NATIVE_LIBRARY_PATH`       | [Snazzah/davey#33](https://github.com/Snazzah/davey/issues/33) (ours, filed 2026-11-25) | No (0.2.0) |

## 1. `@snazzah/davey` ignores `NAPI_RS_NATIVE_LIBRARY_PATH`

**Symptom.** In a compiled app (`absolute compile`, i.e. `bun build --compile`),
Discord voice fails to load DAVE: `@snazzah/davey` throws
`Failed to load native binding`. `@discordjs/voice` 0.19 needs davey for the
DAVE/MLS end-to-end encryption that most Discord voice channels now require
(without it the voice WebSocket closes with 4017 "E2EE/DAVE protocol
required").

**Why it matters here.** `@absolutejs/meeting-discord/compile`
(`discordCompileNativeAssets`, `src/compile.ts`) embeds
`davey.linux-x64-gnu.node` in the binary and points
`NAPI_RS_NATIVE_LIBRARY_PATH` at it, because the per-platform `require` chain
can't resolve inside a single-file binary. That only works if davey honors the
variable.

**Cause.** davey's generated loader (`davey-node/index.js`) assigns the
override instead of returning it:

```js
if (process.env.NAPI_RS_NATIVE_LIBRARY_PATH) {
  try {
    nativeBinding = require(process.env.NAPI_RS_NATIVE_LIBRARY_PATH);
```

so `nativeBinding = requireNative()` overwrites it with `undefined`. The bug is
the napi-rs CLI's template; napi-rs fixed it in
[napi-rs/napi-rs#2907](https://github.com/napi-rs/napi-rs/pull/2907)
(`@napi-rs/cli` 3.2.0), but davey-node is on `@napi-rs/cli` `^3.1.5` and its
committed loader predates the fix (still on `master` and in 0.2.0).

**Workaround.** Apps patch davey with the one-line fix (`return require(...)`):
dealroom (onSpark) carries `patches/@snazzah%2Fdavey@0.1.11.patch` in its
`patchedDependencies` (added 2026-05-26, `fix(referee): make Discord voice work
in compiled prod binary`). Any app using `@absolutejs/meeting-discord/compile`
needs the same until davey ships a regenerated loader.

**Reproduction** (Node 22, Linux x64; passes once fixed):

```sh
mkdir repro && cd repro && npm init -y && npm i @snazzah/davey@<version>
NATIVE=$(node -p "require.resolve('@snazzah/davey-linux-x64-gnu')")
NAPI_RS_NATIVE_LIBRARY_PATH="$NATIVE" node -e "console.log(typeof require('@snazzah/davey').DAVESession)"
# broken: Error: Failed to load native binding     fixed: function
```

**When it's fixed.** Bump `@discordjs/voice` / davey to the fixed release in
dealroom, run the reproduction, delete dealroom's davey patch and its
`patchedDependencies` entry, check a compiled server still joins a DAVE voice
channel, then move this entry to a "Resolved" section.
