import { build } from 'esbuild';
import { resolve } from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
const root = resolve(process.argv[2] ?? 'upstream');
await mkdir('runtime', { recursive: true });
await build({
  stdin: { resolveDir: root, loader: 'ts', contents: `
export { createDownload } from './packages/ai/src/util/download/create-download.ts';
export { downloadBlob } from './packages/provider-utils/src/download-blob.ts';
export { DEFAULT_MAX_DOWNLOAD_SIZE } from './packages/provider-utils/src/read-response-with-size-limit.ts';
` },
  outfile: 'runtime/sdk.mjs', bundle: true, platform: 'node', format: 'esm',
  alias: {
    '@ai-sdk/provider': resolve(root, 'packages/provider/src/index.ts'),
    '@ai-sdk/provider-utils': resolve(root, 'packages/provider-utils/src/index.ts'),
  },
  plugins: [{ name: 'loopback-fixture', setup(b) {
    b.onLoad({ filter: /[\\/]fetch-untrusted-url\.ts$/ }, () => ({ loader: 'ts', contents: `
export async function fetchUntrustedUrl({url, abortSignal}) {
  const parsed = new URL(url);
  if (parsed.origin !== globalThis.fixtureOrigin || parsed.hostname !== '127.0.0.1') throw new Error('Fixture origin required');
  return globalThis.fixtureFetch(parsed, {signal: abortSignal});
}` }));
  } }],
});
await copyFile('ci/workload.mjs', 'runtime/workload.mjs');
