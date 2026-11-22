# Tauri vs Electron for the software factory app

As of 2026-11-22.

**The app:** a local React dashboard and control panel for the factory, running on a Mac that already has `node`, `git`, `gh`, `claude` and `codex` installed. Its main jobs:

- show runs live;
- start, retry and stop runs;
- manage worktrees;
- send notifications;
- sit in the tray.

**The design rule:** all logic stays in `factory.mjs` (Node), behind the `F` CLI, plus an `F serve` command that serves the UI and pushes live updates. The desktop framework is only a shell around that.

## Final decision: Electron

Both reference apps are built with Electron:

- **Claude desktop:** Electron. A teardown found it, Boris Cherny's reported comments back it, and Felix Rieseberg, who leads the desktop work, co-founded Electron ([dbreunig: Why is Claude an Electron app?](https://www.dbreunig.com/2026/02/21/why-is-claude-an-electron-app.html), [telkins: teardown of the Claude desktop app](https://telkins.com/blog/a-teardown-of-the-claude-desktop-app)). Anthropic hasn't documented it officially.
- **OpenAI Codex app:** Electron. Romain Huet, OpenAI's head of developer experience, said it lets them "iterate faster" and bring the app to Windows and Linux ([Simon Willison on the Codex app](https://simonwillison.net/2026/Feb/2/introducing-the-codex-app/), [HN thread](https://news.ycombinator.com/item?id=46859054)). One developer's notes report Electron 40 with Electron Forge ([codex-intel repackaging](https://github.com/Sancerio/codex-intel)).

The decision rule was "if they use Electron, then Electron." Electron also fits the factory's own needs:

- `factory.mjs` runs in-process (main process or `utilityProcess`).
- The Claude Agent SDK and `node-pty` terminals are available.
- Playwright drives it directly.
- It's TypeScript everywhere.

**Efficiency mitigations, given the user's priority:**

- Ship with Electron Forge.
- Keep one window, and run `F serve` in a `utilityProcess`.
- Lazy-load heavy views.
- Follow the security checklist: context isolation, sandbox, no `nodeIntegration`, and a typed `contextBridge` API that only calls `F` ([Electron security](https://electronjs.org/docs/latest/tutorial/security)).

The analysis below is kept for reference.

## Earlier verdict (superseded)

**Use Tauri 2 as a thin shell.** It is the better fit for the stated priority (efficiency in storage, memory and performance), and the usual Tauri downsides mostly don't apply here:

| Usual Tauri downside | Why it doesn't bite here |
|---|---|
| "Node code needs a bundled sidecar, so you lose the size win" | Node is already installed on this machine. The app spawns the system `node factory.mjs serve` and doesn't bundle a runtime. Tauri's docs cover the bundled-sidecar route if it's ever needed ([Tauri: Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)). |
| "Three browser engines (WebView2, WKWebView, WebKitGTK) render differently" | It's a single-user Mac tool, so only WKWebView matters. Linux WebKitGTK GPU bugs are the worst cases reported ([Tauri: Linux graphics issues](https://v2.tauri.app/develop/debug/linux-graphics/)), and they don't apply. |
| "You must write Rust" | With the logic in Node, the Rust side is a few lines: spawn `F serve`, open a window, and use the official notification, autostart, updater and shell plugins. |

**Pick Electron instead if any of these become true:**

- You want to run agents *in-process* through the Claude Agent SDK (TypeScript), or embed real terminals (`node-pty`), rather than spawning CLIs.
- You will ship to Windows or Linux users and need identical rendering everywhere.
- You want zero Rust or Tauri config, and to debug everything in one Chromium DevTools.

Because the UI is plain React talking to `F serve` over HTTP, **switching later costs about a day**: the UI and server stay as they are and only the shell is replaced. That is the real hedge.

## Head-to-head

| Dimension | Tauri 2 | Electron | Winner for this app |
|---|---|---|---|
| **Installer size** | About 3–10 MB for simple to medium apps | About 85–250 MB, since it ships Chromium | Tauri ([tech-insider 2026 test](https://tech-insider.org/tauri-vs-electron-2026/), [Better Stack](https://betterstack.com/community/guides/scaling-nodejs/tauri-vs-electron-vs-deno-vs-electrobun/)) |
| **Idle RAM** | Roughly 40–170 MB | Roughly 160–410 MB; reports put Tauri 50–75% lower | Tauri ([Hopp benchmark](https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4), [tech-insider](https://tech-insider.org/tauri-vs-electron-2026/)) |
| **Startup** | Faster in some tests (0.4 s vs 1.4 s); negligible difference in others | Slower cold start | Tauri, slightly ([Hopp](https://dev.to/gethopp/tauri-vs-electron-performance-bundle-size-and-the-real-trade-offs-1el4)) |
| **Running `factory.mjs`** | Spawn system Node through the shell plugin; needs an explicit `shell:allow-spawn` capability | Import it directly in the main process, or run it in a `utilityProcess` | Electron (simpler), but it's a non-issue for a thin shell |
| **Agent SDK / pty in-process** | Not possible in the webview; it would need a Node sidecar | Native | Electron |
| **Rendering consistency** | System webview per OS; WKWebView capped at 60 fps; WebKitGTK quirks | The same Chromium everywhere | Electron (irrelevant on a Mac-only tool) ([WKWebView 60 fps thread](https://developer.apple.com/forums/thread/796512)) |
| **Security model** | Capabilities allow-list per command and plugin, with deny by default | Secure if configured: context isolation, sandbox (default since v20), no `nodeIntegration` | Tauri (safer by default) ([Electron security checklist](https://electronjs.org/docs/latest/tutorial/security)) |
| **Ecosystem / maturity** | Younger (v2), with fewer plugins | Very mature (VS Code, Slack and others) | Electron ([LogRocket](https://blog.logrocket.com/why-use-electron-alternative)) |
| **Testing the UI** | Chromium-only Playwright doesn't match WKWebView, and there's no WebDriver for macOS WKWebView | Playwright drives Electron directly | Electron ([Playwright engine pitfall](https://takazudo-zudo-tauri.pages.dev/pj/zudo-tauri/docs/frontend/playwright-engine-pitfall)) |
| **Language** | Rust (shell) plus TS (UI) | TS everywhere | Electron |

## Mitigations if you go with Tauri

- **Test the UI in a browser against `F serve` with Playwright using WebKit,** not Chromium; that's closest to WKWebView. Then smoke-test the packaged app by hand ([Playwright engine pitfall](https://takazudo-zudo-tauri.pages.dev/pj/zudo-tauri/docs/frontend/playwright-engine-pitfall)).
- **Keep the webview capabilities minimal.** The UI talks only to `http://127.0.0.1:<port>` served by `F serve`. Bind to loopback with a random per-launch token, and grant the webview no shell permission; only the Rust side spawns `F serve`.
- **Kill `F serve` on app exit,** from Rust with `CommandChild::kill()`, so no orphaned Node processes stay running.

## What I didn't check

- **Benchmark quality:** the size and RAM numbers come from blog benchmarks with different methods (directional, not exact). I did not benchmark a Tauri or Electron build of this app.
- **Current Electron stable version:** not confirmed; the search only surfaced a v46 alpha with conflicting dates.
- **What the Claude and Codex desktop apps are built with:** not confirmed by any source found.
