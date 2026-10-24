import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { DEFAULT_MAX_DOWNLOAD_SIZE, createDownload, downloadBlob } from './sdk.mjs';

const MiB = 1024 ** 2;
const [mode, sizeArg, limitArg, budgetArg] = process.argv.slice(2);
const size = Number(sizeArg) * MiB;
const budget = Number(budgetArg) * MiB;
const limit = limitArg === 'default' ? undefined : Number(limitArg) * MiB;
if (!['data', 'blob', 'native'].includes(mode) || !Number.isSafeInteger(size) || size < 0 || size > 160 * MiB || budget < 192 * MiB || budget > 512 * MiB || (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))) throw new Error('Invalid bounded configuration');
const cg = name => { try { return readFileSync('/sys/fs/cgroup/' + name, 'utf8').trim(); } catch { return null; } };
if (cg('memory.max') !== String(budget) || cg('memory.swap.max') !== '0') throw new Error('Cgroup budget verification failed');
let consumed = 0, served = 0;
const peak = {}, events = [];
const sample = event => {
  const m = process.memoryUsage();
  for (const [k,v] of Object.entries(m)) peak[k] = Math.max(peak[k] ?? 0, v);
  if (event) events.push({ event, consumed, ...m, cgroupCurrent: cg('memory.current'), cgroupPeak: cg('memory.peak'), cgroupEvents: cg('memory.events') });
};
const server = http.createServer(async (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  let emitted = 0;
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  while (emitted < size && !res.destroyed) {
    const piece = chunk.subarray(0, Math.min(chunk.length, size - emitted));
    emitted += piece.length; served += piece.length;
    if (!res.write(piece)) {
      const proceed = await new Promise(resolve => { const cleanup = () => {res.off('drain', drain); res.off('close', close);}; const drain = () => {cleanup(); resolve(true);}; const close = () => {cleanup(); resolve(false);}; res.once('drain', drain); res.once('close', close); });
      if (!proceed) return;
    }
  }
  res.end();
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
globalThis.fixtureOrigin = `http://127.0.0.1:${server.address().port}`;
const url = new URL('/stream', globalThis.fixtureOrigin);
globalThis.fixtureFetch = async (url, options) => {
  const response = await fetch(url, options);
  const reader = response.body.getReader();
  return new Response(new ReadableStream({
    async pull(controller) { const part = await reader.read(); if (part.done) { sample('body-complete'); controller.close(); } else { consumed += part.value.length; controller.enqueue(part.value); } },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 0 }), { headers: response.headers, status: response.status });
};
const originalSet = Uint8Array.prototype.set;
Uint8Array.prototype.set = function(source, offset) { const result = originalSet.call(this, source, offset); if (this.length === size && (offset === 0 || offset + source.length === size)) sample('concatenation'); return result; };
const OriginalBlob = Blob;
globalThis.Blob = class extends OriginalBlob { constructor(...args) { sample('before-blob'); super(...args); sample('after-blob'); } };
global.gc?.(); sample('baseline');
console.log(JSON.stringify({ event: 'start', node: process.version, mode, payloadBytes: size, configuredLimit: limit ?? DEFAULT_MAX_DOWNLOAD_SIZE, budget, cgroupMax: cg('memory.max'), cgroupSwapMax: cg('memory.swap.max') }));
const timer = setInterval(() => sample(), 5);
let outcome;
try {
  const result = mode === 'native' ? new Uint8Array(await (await globalThis.fixtureFetch(url)).arrayBuffer()) : mode === 'blob' ? await downloadBlob(url.toString(), {maxBytes: limit}) : await createDownload({maxBytes: limit})({url});
  const bytes = mode === 'native' ? result.length : mode === 'blob' ? result.size : result.data.length;
  sample('returned'); outcome = { kind: 'success', bytes };
} catch (e) { sample('caught'); outcome = { kind: 'caught', name: e.name, message: e.message, cause: e.cause && { name: e.cause.name, message: e.cause.message } }; }
finally { clearInterval(timer); Uint8Array.prototype.set = originalSet; globalThis.Blob = OriginalBlob; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify({ event: 'result', outcome, consumed, served, peak, events, cgroupEvents: cg('memory.events'), cgroupPeak: cg('memory.peak') }));
