// zip.ts: a .livliv as LivLiv writes it, as Finder's / Windows' "compress" writes it, and the ones
// it must refuse. The ZIPs are made here (stored / deflated entries, a central directory), and with macOS's ditto
// (Finder's compress: a wrapping folder, __MACOSX) where it exists.
//   node --test web/sdk/test/
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { ZIP_LIMITS, isZip, unzip } from '../src/zip.ts'

interface Entry { name: string; data: Uint8Array; method?: 0 | 8; flags?: number; usize?: number }

/** a ZIP of these entries: local headers, data, central directory, end record (CRCs left 0: unzip does not check them) */
function zip(entries: Entry[], opts: { count?: number } = {}): Blob {
  const enc = new TextEncoder(), parts: Uint8Array[] = [], cd: Uint8Array[] = []
  let off = 0
  for (const e of entries) {
    const name = enc.encode(e.name), method = e.method ?? 0
    const body = method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(6, e.flags ?? 0x800, true); lh.setUint16(8, method, true)
    lh.setUint32(18, body.length, true); lh.setUint32(22, e.usize ?? e.data.length, true); lh.setUint16(26, name.length, true)
    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(8, e.flags ?? 0x800, true); ch.setUint16(10, method, true)
    ch.setUint32(20, body.length, true); ch.setUint32(24, e.usize ?? e.data.length, true); ch.setUint16(28, name.length, true)
    ch.setUint32(42, off, true)
    parts.push(new Uint8Array(lh.buffer), name, body)
    cd.push(new Uint8Array(ch.buffer), name)
    off += 30 + name.length + body.length
  }
  const cdSize = cd.reduce((n, p) => n + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, opts.count ?? entries.length, true); end.setUint16(10, opts.count ?? entries.length, true)
  end.setUint32(12, cdSize, true); end.setUint32(16, off, true)
  return new Blob([...parts, ...cd, new Uint8Array(end.buffer)] as BlobPart[])
}
const bytes = (s: string) => new TextEncoder().encode(s)
const text = async (b: Blob | undefined) => (b ? b.text() : undefined)

test('a package as LivLiv writes it: stored images and model.json, deflated keyforms', async () => {
  const kf = JSON.stringify({ version: 1, keys: Array.from({ length: 200 }, (_, i) => ({ param: 'angleX', value: i })) })
  const z = zip([
    { name: 'model.json', data: bytes('{"format":"livliv-model"}') },
    { name: 'textures/body.webp', data: bytes('RIFFxxxxWEBP') },
    { name: 'keyforms.json', data: bytes(kf), method: 8 },
  ])
  assert.equal(await isZip(z), true)
  const files = await unzip(z)
  assert.deepEqual([...files.keys()], ['model.json', 'textures/body.webp', 'keyforms.json'])
  assert.equal(await text(files.get('model.json')), '{"format":"livliv-model"}')
  assert.equal(files.get('textures/body.webp')!.type, 'image/webp')
  assert.equal(await text(files.get('keyforms.json')), kf)
})

test('a hand-made one: inside one folder, with Finder litter, deflated everywhere', async () => {
  const z = zip([
    { name: 'Sena/', data: bytes('') },
    { name: 'Sena/model.json', data: bytes('{"a":1}'), method: 8 },
    { name: 'Sena/textures/body.webp', data: bytes('webp bytes'), method: 8 },
    { name: '__MACOSX/Sena/._model.json', data: bytes('resource fork') },
    { name: 'Sena/.DS_Store', data: bytes('x') },
    { name: 'Sena\\textures\\face.webp', data: bytes('backslashed') },  // some Windows tools
  ])
  const files = await unzip(z)
  assert.deepEqual([...files.keys()].sort(), ['Sena/model.json', 'Sena/textures/body.webp', 'Sena/textures/face.webp'])
  assert.equal(await text(files.get('Sena/textures/body.webp')), 'webp bytes')
})

test('refusals', async () => {
  const one = (e: Partial<Entry>) => zip([{ name: 'model.json', data: bytes('{}'), ...e }])
  await assert.rejects(unzip(new Blob([bytes('not a zip at all')])), /not a ZIP/)
  assert.equal(await isZip(new Blob([bytes('{"format":1}')])), false)
  await assert.rejects(unzip(one({ name: '../model.json' })), /outside itself/)
  await assert.rejects(unzip(one({ name: '/etc/model.json' })), /outside itself/)
  await assert.rejects(unzip(one({ name: 'C:/x/model.json' })), /outside itself/)
  await assert.rejects(unzip(one({ name: 'a/./model.json' })), /outside itself/)
  await assert.rejects(unzip(one({ flags: 0x801 })), /encrypted/)
  await assert.rejects(unzip(one({ method: 12 as 0 })), /method 12/)
  await assert.rejects(unzip(zip([{ name: 'a.json', data: bytes('1') }, { name: 'a.json', data: bytes('2') }])), /twice/)
  await assert.rejects(unzip(zip([{ name: 'model.json', data: bytes('{}') }], { count: 0xffff })), /ZIP64/)
  await assert.rejects(unzip(one({ usize: ZIP_LIMITS.modelJson + 1, method: 8 })), /too large/)
  // a bomb: a small entry that says it holds 1 KB and inflates to 1 MB stops at 1 KB
  await assert.rejects(unzip(zip([{ name: 'keyforms.json', data: new Uint8Array(2 ** 20), method: 8, usize: 1024 }])), /past its 1024 bytes/)
  // and one that says more than it holds
  await assert.rejects(unzip(zip([{ name: 'model.json', data: bytes('{}'), method: 8, usize: 10 }])), /damaged/)
})

test('rejects oversized and out-of-bounds central directories before allocation', async () => {
  const original = new Uint8Array(await zip([{ name: 'model.json', data: bytes('{}') }]).arrayBuffer())
  for (const [offset, value, expected] of [[12, 5 * 2 ** 20, /central directory exceeds/], [16, original.length, /central directory extends/]] as const) {
    const data = original.slice()
    new DataView(data.buffer).setUint32(data.length - 22 + offset, value, true)
    await assert.rejects(unzip(new Blob([data])), expected)
  }
})

test('Finder\'s compress (ditto): the folder inside, __MACOSX beside it', { skip: !existsSync('/usr/bin/ditto') }, async () => {
  const d = mkdtempSync(join(tmpdir(), 'livliv-zip-'))
  mkdirSync(join(d, 'Sena', 'textures'), { recursive: true })
  writeFileSync(join(d, 'Sena', 'model.json'), '{"format":"livliv-model","version":4}')
  writeFileSync(join(d, 'Sena', 'textures', 'body.webp'), 'webp '.repeat(100))
  execFileSync('/usr/bin/xattr', ['-w', 'com.livliv.test', 'x', join(d, 'Sena', 'model.json')])  // so ditto writes a ._ file
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(d, 'Sena'), join(d, 'Sena.zip')])
  const files = await unzip(new Blob([readFileSync(join(d, 'Sena.zip'))]))
  assert.deepEqual([...files.keys()].sort(), ['Sena/model.json', 'Sena/textures/body.webp'])
  assert.equal(await text(files.get('Sena/model.json')), '{"format":"livliv-model","version":4}')
})
