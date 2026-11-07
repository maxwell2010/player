import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readBody } from '../src/base'

const job = () => ({ signal: new AbortController().signal, progress() {}, build() {} })
test('download rejects oversized declared body before reading', async () => {
  await assert.rejects(readBody(new Response('large', { headers: { 'content-length': '500' } }), job(), undefined, 4), { code: 'too-large' })
})
test('download rejects oversized streamed body without content length', async () => {
  await assert.rejects(readBody(new Response('12345'), job(), undefined, 4), { code: 'too-large' })
})
test('download accepts body within limit', async () => {
  assert.equal(await (await readBody(new Response('1234'), job(), undefined, 4)).text(), '1234')
})
test('download abort interrupts a stalled response', async () => {
  const controller = new AbortController()
  const r = new Response(new ReadableStream({ start() {} }))
  const reading = readBody(r, { ...job(), signal: controller.signal })
  controller.abort(new DOMException('cancelled', 'AbortError'))
  await assert.rejects(reading, { name: 'AbortError' })
})
