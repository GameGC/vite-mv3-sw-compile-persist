<div align="center">

### Write your Chrome MV3 background worker like it never dies. The plugin makes it true.

**Your `let` variables survive service-worker restarts. Your `setTimeout`s survive too. Zero boilerplate, zero runtime library — it all happens at build time.**

[![npm](https://img.shields.io/npm/v/vite-mv3-sw-compile-persist.svg?color=cb3837&logo=npm)](https://www.npmjs.com/package/vite-mv3-sw-compile-persist)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Vite](https://img.shields.io/badge/Vite-%E2%89%A58.0-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Tests](https://img.shields.io/badge/tests-66%20passing-3fb950)](#-quality)

</div>

---

## 💀 The problem that ruins every MV3 extension

In Manifest V3, your background **service worker is killed after ~30 seconds of inactivity.** When it restarts, everything is gone:

```js
// background.ts — looks innocent, breaks in production
let requestCount = 0;          // 💥 resets to 0 on every restart
let cache = new Map();         // 💥 wiped
let isSyncing = false;         // 💥 lock lost → duplicate work

setTimeout(runCleanup, 5 * 60_000);  // 💥 never fires — SW died first
```

The official fix? Manually serialize **every** variable to `chrome.storage`, `await` it back on every event, and rewrite every timer as a `chrome.alarms` call. Hundreds of lines of error-prone plumbing in every extension.

## ✨ The fix: just write normal code

Add one plugin. Keep writing plain JavaScript. The plugin rewrites your worker at build time so state and timers **actually persist**.

```js
// You write this ↓
let requestCount = 0;
requestCount++;

// The plugin ships this ↓ (auto-persisted to chrome.storage.session)
let requestCount = 0;
requestCount++; __mv3_markDirty('requestCount');
// + restore-on-startup, debounced flush, alarm-backed timers… all generated
```

No decorators. No wrapper API. No `await storage.get()` sprinkled everywhere. **Your source stays clean.**

---

## 🚀 Quick start (60 seconds)

**1. Install**

```bash
npm i -D vite-mv3-sw-compile-persist
```

**2. Add to `vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import { mv3Persistent } from 'vite-mv3-sw-compile-persist';

export default defineConfig({
  plugins: [
    mv3Persistent({
      // matches src/background/index.ts by default
      backgroundEntry: /background[\\/]index\.ts$/,
    }),
  ],
});
```

**3. Write your worker as if it never restarts**

```ts
// src/background/index.ts
let counter = 0;

chrome.action.onClicked.addListener(() => {
  counter++;                         // ← automatically persisted
  console.log('clicked', counter);
});

setTimeout(() => cleanup(), 5 * 60_000);  // ← automatically survives restarts
```

That's it. Reload the extension, kill the worker from `chrome://serviceworker-internals`, click again — **`counter` keeps counting.** 🎉

> Requires the `storage` permission (and `alarms` if you use long timers) in your `manifest.json`.

---

## 🎬 Before / After

<table>
<tr><th align="left">Without the plugin (manual MV3)</th><th align="left">With the plugin</th></tr>
<tr valign="top">
<td>

```ts
async function getCount() {
  const { count = 0 } =
    await chrome.storage.session.get('count');
  return count;
}
async function setCount(v) {
  await chrome.storage.session.set({ count: v });
}

chrome.action.onClicked.addListener(async () => {
  const count = await getCount();
  await setCount(count + 1);
});

// timers → alarms by hand
chrome.alarms.create('cleanup',
  { delayInMinutes: 5 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'cleanup') cleanup();
});
```

</td>
<td>

```ts
let count = 0;

chrome.action.onClicked.addListener(() => {
  count++;
});

setTimeout(cleanup, 5 * 60_000);
```

</td>
</tr>
</table>

---

## 💡 Why you'll love it

- **🧠 Zero-boilerplate persistence** — plain `let`/`var` at the top level are tracked and restored automatically.
- **⏰ Timers that survive death** — long `setTimeout`/`setInterval` are transparently backed by `chrome.alarms`; short ones stay native.
- **🔍 AST-powered, not regex** — built on Babel. It understands your code, so it only rewrites what it should.
- **🪶 No runtime dependency shipped** — the persistence layer is generated into your bundle. Nothing to `import`, nothing extra to load.
- **🎯 Smart & safe** — never breaks `onMessage` `return true`, never breaks blocking `webRequest` (those handlers stay synchronous).
- **🧩 Objects, arrays, `Map`, `Set`, `Date`** — opt into `proxy` mode and even nested mutations mark state dirty automatically.
- **🔐 Stale-lock recovery** — boolean "is-running" flags are auto-cleared when a worker dies mid-task, so you never deadlock.
- **📦 TypeScript-first** — full types, ESM + CJS, works with any Vite ≥ 8 extension setup.

---

## ⚙️ Configuration

Every option is optional. Sensible defaults ship out of the box.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `backgroundEntry` | `string \| RegExp` | `/background[\/]index\.ts$/` | Which file is your background worker. |
| `persistentVars` | `string[]` | `[]` (auto-detect) | Whitelist of variables to persist. Empty = persist all eligible top-level vars. |
| `excludeVars` | `string[]` | `[]` | Variables to never persist. |
| `storageArea` | `'session' \| 'local'` | `'session'` | `session` clears on browser close; `local` survives it. |
| `stateStrategy` | `'static' \| 'proxy'` | `'static'` | `static` = fast AST dirty-tracking. `proxy` = also catch nested/`Map`/`Set`/`Date` mutations at runtime. |
| `alarmThresholdMs` | `number` | `60_000` | Timers ≥ this delay become `chrome.alarms`; shorter stay native. |
| `keepaliveStrategy` | `'alarm' \| 'offscreen' \| 'none'` | `'alarm'` | How to keep the worker alive during pending timers. |
| `autoFlushMs` | `number` | `2_000` | Debounce interval for writing dirty state to storage (`0` disables). |
| `staleLockThresholdMs` | `number` | `30_000` | How long a boolean lock may persist before being treated as stale on restart. |
| `promiseResolverStrategy` | `'native' \| 'alarm'` | `'native'` | How to treat `setTimeout` inside `new Promise(...)` executors. |
| `namedAlarmHandlers` | `Record<string,string>` | `{}` | Map alarm names to recovery functions for callbacks that can't be auto-persisted. |
| `safeClosureVars` | `string[]` | `[]` | Closure vars (e.g. singletons) to treat as safe and not warn about. |

### Recommended setup for stateful workers

```ts
mv3Persistent({
  backgroundEntry: /background[\\/]index\.ts$/,
  stateStrategy: 'proxy',   // track Map/Set/Date and nested object mutations
  storageArea: 'session',
  alarmThresholdMs: 60_000,
});
```

---

## 🔬 How it works

At build time the plugin runs three passes over your background entry:

1. **Analyze** — Babel parses the file and collects top-level state, timers, event handlers, and every assignment/mutation.
2. **Transform** — [`magic-string`](https://github.com/Rich-Harris/magic-string) surgically rewrites the source (with source maps):
   - assignments get an auto `__mv3_markDirty(...)` — even inside brace-less `if`/`for`/`while` bodies, which are safely wrapped;
   - long timers become alarm-backed wrappers, callbacks registered so they can be recovered after a restart;
   - event handlers get `await __mv3_init` so restored state is guaranteed ready.
3. **Generate runtime** — a per-build persistence layer is emitted as a virtual module and inlined. Restore-on-startup, debounced flushing, `Map`/`Set`/`Date` (de)serialization, and stale-lock recovery are all handled for you.

Nothing runs unless your background worker actually restarts — the common path stays fast.

---

## ✅ Quality

- **66 tests passing** across transform, control-flow bracing, and serialization suites.
- Builds to **ESM + CJS with full `.d.ts`** typings.
- AST-driven design — deterministic output, readable diffs, source maps included.

```bash
npm test
```

---

## 📋 Requirements

- Vite **≥ 8.0**
- A Chrome (or Chromium) **Manifest V3** extension
- `manifest.json` permissions: `"storage"` (always) and `"alarms"` (for long timers); `"offscreen"` only if you choose `keepaliveStrategy: 'offscreen'`.

---

## 🤝 Contributing

Issues and PRs welcome! If this plugin saved you from MV3 state hell, **drop a ⭐** — it genuinely helps others find it.

**GitHub:** https://github.com/GameGC/vite-mv3-sw-compile-persist

## 📄 License

[Apache 2.0](./LICENSE)
