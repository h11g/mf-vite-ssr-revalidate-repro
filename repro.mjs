import { readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInstance } from '@module-federation/runtime';
import ssrEntryLoaderPlugin, { revalidate } from '@module-federation/vite/ssrEntryLoader';

// scoped: revalidate(entryA)
// all: revalidate()
// drop-global-loading: revalidate(entryA), then delete remote_a's __GLOBAL_LOADING_REMOTE_ENTRY__ entry
// all-drop-global-loading: revalidate(), then delete every __GLOBAL_LOADING_REMOTE_ENTRY__ entry
const MODE = process.argv[2] ?? 'scoped';

// Two hand-written SSR containers on one origin. The widget expose only
// imports its lazy chunk when loadLazy() is called.
const container = (name) => ({
  [`/${name}/remoteEntry.ssr.js`]: `
export function init() {}
export async function get(id) {
  if (id !== './widget') throw new Error('unknown expose ' + id);
  const mod = await import('./widget.js');
  return () => mod;
}`,
  [`/${name}/widget.js`]: `
export async function loadLazy() {
  return (await import('./lazy.js')).default;
}`,
  [`/${name}/lazy.js`]: `export default 'lazy chunk of ${name}';`,
});
const files = { ...container('a'), ...container('b') };

let requests = 0;
const server = createServer((req, res) => {
  requests++;
  const body = Object.hasOwn(files, req.url) ? files[req.url] : undefined;
  if (body === undefined) {
    res.statusCode = 404;
    res.end();
    return;
  }
  res.setHeader('content-type', 'text/javascript');
  res.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const entryA = `${origin}/a/remoteEntry.ssr.js`;
const entryB = `${origin}/b/remoteEntry.ssr.js`;

const loader = ssrEntryLoaderPlugin({ strategy: 'temp-file' });
let loadEntryCalls = 0;
const loadEntry = loader.loadEntry;
loader.loadEntry = (args) => {
  loadEntryCalls++;
  return loadEntry.call(loader, args);
};

const mf = createInstance({
  name: 'host',
  remotes: [
    { name: 'remote_a', entry: entryA, type: 'module' },
    { name: 'remote_b', entry: entryB, type: 'module' },
  ],
  plugins: [loader],
});

const cacheDir = join(process.cwd(), 'node_modules', '.ssr-cache', String(process.pid));
const tempFileCount = () => {
  try {
    return readdirSync(cacheDir).length;
  } catch {
    return 0;
  }
};
const log = (label) =>
  console.log(
    `[${label}] loadEntry calls: ${loadEntryCalls}, HTTP requests: ${requests}, temp files: ${tempFileCount()}`
  );
const globalLoading = globalThis.__GLOBAL_LOADING_REMOTE_ENTRY__;
const loadingKeys = () => Object.keys(globalLoading).map((key) => key.replace(origin, '<origin>'));

console.log(`mode: ${MODE}`);

// 1. First render: load both exposes. Nobody calls loadLazy() yet.
const widgetA = await mf.loadRemote('remote_a/widget');
await mf.loadRemote('remote_b/widget');
log('after first loadRemote');

// 2. The remote did not change, but the host revalidates it (e.g. on a deploy hook).
const revalidateAll = MODE.startsWith('all');
if (revalidateAll) revalidate();
else revalidate(entryA);
if (MODE.endsWith('drop-global-loading')) {
  for (const key of Object.keys(globalLoading)) {
    if (revalidateAll || key.endsWith(entryA)) delete globalLoading[key];
  }
}
console.log('globalLoading keys after revalidate:', loadingKeys());

// 3. Next render, within the 30 s grace period.
const widgetA2 = await mf.loadRemote('remote_a/widget');
log('after loadRemote following revalidate');
console.log('remote_a/widget is the pre-revalidate module:', widgetA2 === widgetA);

// 4. Let the temp-file cleanup timer fire.
await sleep(31_000);
log('31 s later');

// 5. A later render needs the lazy chunk.
for (const id of ['remote_a/widget', 'remote_b/widget']) {
  const widget = await mf.loadRemote(id);
  try {
    console.log(`${id} loadLazy() ->`, await widget.loadLazy());
  } catch (error) {
    console.log(`${id} loadLazy() -> ${error.code}: ${error.message.replaceAll(process.cwd(), '<cwd>')}`);
  }
}
log('end');
server.close();
