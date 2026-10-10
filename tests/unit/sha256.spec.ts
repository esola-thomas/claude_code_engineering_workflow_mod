import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'

import { sha256Hex, sha256HexOfBytes } from '../../src/sha256.ts'

describe('sha256Hex (NIST vectors)', () => {
  it('hashes the empty string', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  it('hashes "abc"', () => {
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('hashes the 448-bit message (two blocks after padding)', () => {
    assert.equal(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  })

  it('hashes the 896-bit message', () => {
    const text = 'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'
    assert.equal(sha256Hex(text), 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1')
  })

  it('hashes one million "a"', () => {
    assert.equal(sha256Hex('a'.repeat(1_000_000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  })

  it('agrees with node:crypto around every padding boundary and for non-ASCII text', () => {
    for (let length = 0; length <= 200; length++) {
      const text = 'x'.repeat(length)
      assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'), `length ${length}`)
    }
    for (const text of ['Añadir ✓ 😀', 'ñandú', '日本語のテキスト', '\u0000\u007f\u0080߿ࠀ￿']) {
      assert.equal(sha256Hex(text), createHash('sha256').update(text).digest('hex'), text)
    }
  })

  it('hashes raw bytes the same way', () => {
    assert.equal(sha256HexOfBytes([0x61, 0x62, 0x63]), sha256Hex('abc'))
  })
})
