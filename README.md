# clangd Filter Files

> ## :robot: AI-generated code notice
>
> **Every line of code in this repository was written by Claude (Anthropic's
> coding agent).** The human author's contribution is limited to:
>
> - Specifying the desired behavior in natural language.
> - Verifying the resulting extension behaves correctly inside VS Code
>   (Insiders) by exercising it on real C/C++ files.
>
> No part of the source has been hand-edited or hand-reviewed line-by-line.
> Treat the code accordingly when auditing for security, correctness, or
> upstream contribution.

A tiny VS Code extension that hooks the
[clangd](https://github.com/clangd/vscode-clangd) language client and **drops
every LSP request and notification for files that live outside any open
workspace folder**. Open a stray `.cpp` from `/tmp` and clangd will not see it
at all — no indexing, no completion, no diagnostics, no `compile_commands.json`
churn for files you never asked it to look at.

## How it works

The official clangd extension exposes a small typed API
([`@clangd/vscode-clangd`](https://github.com/clangd/vscode-clangd/blob/master/api/vscode-clangd.d.ts))
that returns its `BaseLanguageClient` instance. This extension:

1. Activates *after* `llvm-vs-code-extensions.vscode-clangd` (via
   `extensionDependencies`).
2. Reads `api.languageClient.clientOptions.middleware` and merges in a filter
   that short-circuits notifications (`didOpen`, `didChange`, `didSave`,
   `didClose`, `willSave`, `willSaveWaitUntil`) and request providers (hover,
   definition, references, completion, code action, formatting, rename,
   semantic tokens, inlay hints, call/type hierarchy, …) when
   `vscode.workspace.getWorkspaceFolder(uri)` returns `undefined`.
3. Tracks `BaseLanguageClient.onDidChangeState` so that `clangd.restart` and
   crashes re-attach the middleware to the freshly-spawned client.

No clangd internals are patched; only the public middleware surface is used.

## User-facing notifications

Four independent, opt-in channels surface "this file is not indexed":

| Setting | Default | Effect |
| --- | --- | --- |
| `clangd-filter-files.notify.statusBar` | `true` | A warning-tinted `⊘ clangd: not indexed` item appears on the right side of the status bar while the active editor is a non-workspace C/C++ file. |
| `clangd-filter-files.notify.toast` | `false` | One-shot `showWarningMessage` per file URI on `onDidOpenTextDocument`. |
| `clangd-filter-files.notify.diagnostic` | `false` | An `Information` diagnostic is emitted over line 1, visible as a squiggle and in the Problems panel. |
| `clangd-filter-files.notify.banner` | `false` | An inline "⚠ Outside workspace — clangd is not indexing this file" decoration trailing the topmost visible line. The banner re-anchors as you scroll, and offsets itself below the `editor.stickyScroll` panel so it isn't hidden behind sticky headers. Hover the marker for an *Add containing folder to workspace* link. |

## Other settings

- `clangd-filter-files.allowedSchemes` *(default `["file"]`)* — URI schemes
  that participate in the workspace check. Schemes outside this list are
  passed through unchanged (so e.g. `untitled:` or `vscode-vfs:` documents
  still reach clangd if you want).
- `clangd-filter-files.log` *(default `false`)* — log every drop / banner
  re-anchor / restart-reattach to the *clangd Filter Files* output channel.
  Useful for diagnosing why a particular file does or does not get filtered.
- `clangd-filter-files.notify.bannerExtraLineOffset` *(default `0`)* —
  additional lines added on top of the automatic sticky-scroll offset. Bump
  this if the auto offset still leaves the banner too close to the sticky
  panel for your taste.

## Commands

- **clangd Filter Files: Reattach Middleware** — manually re-install the
  filter on the current language client (only needed if you've automated
  something unusual; the state-change watcher normally handles restarts).
- **clangd Filter Files: Add Containing Folder to Workspace** — adds the
  active file's parent directory to the workspace folders, so clangd starts
  indexing it. Available from the palette, and from the banner's hover link.

## Building

```bash
npm install
npm run typecheck   # tsc -noEmit
npm run build       # esbuild bundle into out/extension.js
npx @vscode/vsce package --skip-license --allow-missing-repository \
    --out vscode-clangd-filter-files.vsix
```

`F5` from the project folder launches an Extension Development Host with the
extension loaded.

## License

MIT — see [LICENSE](./LICENSE).
