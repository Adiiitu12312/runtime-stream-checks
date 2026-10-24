import { expect, it, vi } from 'vitest';
import { readResponseWithSizeLimit, DEFAULT_MAX_DOWNLOAD_SIZE } from './read-response-with-size-limit';
import { DownloadError } from './download-error';

const url = 'https://fixture.invalid/stream';
function fixture(size: number, headers?: Record<string, string>) {
  let emitted = 0;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (emitted === size) return controller.close();
      const count = Math.min(3, size - emitted);
      emitted += count;
      controller.enqueue(new Uint8Array(count).fill(0x61));
    }, cancel,
  }, { highWaterMark: 0 }), { headers });
  return { response, cancel, emitted: () => emitted };
}
it('records the pinned default', () => expect(DEFAULT_MAX_DOWNLOAD_SIZE).toBe(2147483648));
it.each([0, 7, 8])('accepts %i bytes at an eight-byte boundary', async size => {
  const f = fixture(size);
  expect(await readResponseWithSizeLimit({response:f.response, url, maxBytes:8})).toEqual(new Uint8Array(size).fill(0x61));
});
it.each([undefined, {'content-length':'invalid'}, {'content-length':'1'}])('counts body bytes independently of header %j', async headers => {
  const f = fixture(9, headers);
  await expect(readResponseWithSizeLimit({response:f.response, url, maxBytes:8})).rejects.toSatisfy((e:unknown) => DownloadError.isInstance(e) && e.name==='AI_DownloadError');
  expect(f.emitted()).toBe(9);
  expect(f.cancel).toHaveBeenCalledOnce();
  expect(f.response.body?.locked).toBe(false);
});
it('rejects an oversized declared length before pulling the body', async () => {
  const f = fixture(9, {'content-length':'9'});
  await expect(readResponseWithSizeLimit({response:f.response,url,maxBytes:8})).rejects.toSatisfy(DownloadError.isInstance);
  expect(f.emitted()).toBe(0);
  expect(f.cancel).toHaveBeenCalledOnce();
});
