# SSR temp-file loader: `revalidate()` deletes files of containers that are still served

Minimal reproduction for `@module-federation/vite` 1.23.1 (`@module-federation/runtime` 2.9.2, vite 8.3.2, Node 24). With 1.23.0 the same script keeps all temp files and `loadLazy()` works.

No Vite build is needed: `repro.mjs` starts a `node:http` server with two hand-written SSR containers (`/a/` and `/b/`, same origin), then loads them through `createInstance` + the SSR entry loader plugin (`strategy: 'temp-file'`).

Each container exposes `./widget`, and the widget has `loadLazy()`, which does `await import('./lazy.js')`.

## Steps

```sh
npm install
node repro.mjs                           # revalidate(entryA)
node repro.mjs all                       # revalidate()
node repro.mjs drop-global-loading       # revalidate(entryA) + delete remote_a's __GLOBAL_LOADING_REMOTE_ENTRY__ entry
node repro.mjs all-drop-global-loading   # revalidate() + delete every __GLOBAL_LOADING_REMOTE_ENTRY__ entry
node force-check.mjs                     # registerRemotes(..., { force: true }) right after revalidate()
```

Each `repro.mjs` run takes about 31 s because it waits for the loader's 30 s temp-file cleanup timer.

The script:

1. loads `remote_a/widget` and `remote_b/widget` without calling `loadLazy()`
2. calls `revalidate(entryA)`, even though the remote content has not changed
3. loads `remote_a/widget` again
4. waits 31 s
5. loads both widgets again and calls `loadLazy()` on each

## Expected

- After `revalidate(entryA)`, the next `loadRemote('remote_a/widget')` goes through `loadEntry` again and gets a fresh container.
- `loadLazy()` works for any module resolved by `loadRemote()`, including `remote_b`, which was never revalidated.

## Actual

- `loadEntry` is not called again, and no HTTP request is made. runtime-core hands back the old container from `globalThis.__GLOBAL_LOADING_REMOTE_ENTRY__`.
- 30 s later, every temp file of the origin is deleted, including `remote_b`'s.
- `loadRemote()` still succeeds, but `loadLazy()` throws `ERR_MODULE_NOT_FOUND` for both remotes.

With `drop-global-loading`, `remote_a` is reloaded and its lazy chunk works. `remote_b` still fails, because the cleanup removes its files by origin.

With `all-drop-global-loading`, both lazy chunks work, because every remote is reloaded into a new generation on its next `loadRemote()`.

`force-check.mjs` shows that `registerRemotes(..., { force: true })` does not lead to a new `loadEntry` right after `revalidate()`, but does once a `loadRemote()` has refilled `moduleCache`.
