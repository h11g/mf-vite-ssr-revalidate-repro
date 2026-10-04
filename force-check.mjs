// registerRemotes(..., { force: true }) only drops a remote's
// __GLOBAL_LOADING_REMOTE_ENTRY__ entry while moduleCache still holds that
// remote's Module. revalidate() clears moduleCache first, so the forced
// re-register right after it does not lead to a new loadEntry.
import { createServer } from 'node:http';
import { createInstance } from '@module-federation/runtime';
import ssrEntryLoaderPlugin, { revalidate } from '@module-federation/vite/ssrEntryLoader';

const files = {
  '/a/remoteEntry.ssr.js': `
export function init() {}
export async function get() {
  const mod = await import('./widget.js');
  return () => mod;
}`,
  '/a/widget.js': `export const v = 1;`,
};

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
const entry = `http://127.0.0.1:${server.address().port}/a/remoteEntry.ssr.js`;

const loader = ssrEntryLoaderPlugin();
let loadEntryCalls = 0;
const loadEntry = loader.loadEntry;
loader.loadEntry = (args) => {
  loadEntryCalls++;
  return loadEntry.call(loader, args);
};
const remote = { name: 'remote_a', entry, type: 'module' };
const mf = createInstance({ name: 'host', remotes: [remote], plugins: [loader] });

await mf.loadRemote('remote_a/widget');
console.log(`initial load -> loadEntry calls: ${loadEntryCalls}, HTTP requests: ${requests}`);

// moduleCache is empty here, so the forced re-register cannot find the Module.
revalidate(entry);
mf.registerRemotes([remote], { force: true });
await mf.loadRemote('remote_a/widget');
console.log(`revalidate() then force -> loadEntry calls: ${loadEntryCalls}, HTTP requests: ${requests}`);

// The loadRemote() above refilled moduleCache, so this time force works.
mf.registerRemotes([remote], { force: true });
await mf.loadRemote('remote_a/widget');
console.log(`force only -> loadEntry calls: ${loadEntryCalls}, HTTP requests: ${requests}`);
server.close();
