import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { PENDING_DELIVERED_LIMIT, PENDING_TTL_MS, createPending, pendingFileStem } from '../lib/core.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'mtts-pending-'))
const modeOf = (file) => statSync(file).mode & 0o777
const clock = { value: Date.parse('2026-01-01T00:00:00Z') }

function harness() {
  const dir = tempDir()
  const pending = createPending({ dir, now: () => clock.value })
  return { dir, pending, file: (sessionId) => join(dir, `${pendingFileStem(sessionId)}.json`), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('pendingFileStem：净化非法字符，空 id 降级为 current', () => {
  assert.equal(pendingFileStem('sess-1_abc.2'), 'sess-1_abc.2')
  assert.equal(pendingFileStem('../../etc/passwd'), '__.._etc_passwd')
  assert.equal(pendingFileStem(''), 'current')
  assert.equal(pendingFileStem(undefined), 'current')
  assert.equal(pendingFileStem('   '), 'current')
})

test('pending：初始为空；add 落盘 0600 且带 id/createdAt/expiresAt', () => {
  const h = harness()
  try {
    assert.deepEqual(h.pending.list('s1'), [])
    const item = h.pending.add('s1', { text: '第一条', model: 'speech-2.8-hd', voiceId: 'female-shaonv' })
    assert.match(item.id, /^[0-9a-f-]{36}$/)
    assert.equal(item.text, '第一条')
    assert.equal(item.source, 'script')
    // 认领即消费：条目上没有 claimed / binding 这类「已消费」标记
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'expiresAt', 'id', 'model', 'params', 'source', 'text', 'voiceId'])
    assert.equal(item.createdAt, clock.value)
    assert.equal(item.expiresAt, clock.value + PENDING_TTL_MS)
    assert.equal(modeOf(h.file('s1')), 0o600)
    assert.deepEqual(h.pending.list('s1').map((entry) => entry.id), [item.id])
  } finally { h.done() }
})

test('pending：add 取代全部旧条目并累计 superseded', () => {
  const h = harness()
  try {
    h.pending.add('s1', { text: '第一条' })
    clock.value += 1000
    const second = h.pending.add('s1', { text: '第二条' })
    const items = h.pending.list('s1')
    assert.deepEqual(items.map((entry) => entry.id), [second.id])
    assert.equal(items[0].text, '第二条')
    assert.equal(JSON.parse(readFileSync(h.file('s1'), 'utf8')).superseded, 1)

    clock.value += 1000
    h.pending.add('s1', { text: '第三条' })
    assert.equal(JSON.parse(readFileSync(h.file('s1'), 'utf8')).superseded, 2)
  } finally { h.done() }
})

test('pending：认领即消费——claim 后条目从文件里消失，文件本身留着做审计', () => {
  const h = harness()
  try {
    const first = h.pending.add('s1', { text: '会被认领的' })
    const claimed = h.pending.claim('s1')
    assert.equal(claimed.id, first.id)
    assert.equal(claimed.text, '会被认领的')
    // 返回的条目本身就是待播内容，不再有 claimed / binding 这套「标记后保留」的中间态
    assert.deepEqual(h.pending.list('s1'), [])
    const file = JSON.parse(readFileSync(h.file('s1'), 'utf8'))
    assert.deepEqual(file.items, [])
    assert.equal(file.superseded, 0)

    clock.value += 1000
    const second = h.pending.add('s1', { text: '认领之后还能再登记' })
    assert.deepEqual(h.pending.list('s1').map((entry) => entry.id), [second.id])
    assert.equal(JSON.parse(readFileSync(h.file('s1'), 'utf8')).superseded, 0)
  } finally { h.done() }
})

test('pending：claim 取最早的未认领条目并只删那一条', () => {
  const h = harness()
  try {
    const base = clock.value
    h.pending.storeFor('s1').write({
      version: 1,
      sessionId: 's1',
      superseded: 0,
      items: [
        { id: 'later', text: 'b', createdAt: base + 2000, expiresAt: base + PENDING_TTL_MS },
        { id: 'earlier', text: 'a', createdAt: base + 1000, expiresAt: base + PENDING_TTL_MS },
      ],
    })
    const first = h.pending.claim('s1')
    assert.equal(first.id, 'earlier')
    assert.equal(first.text, 'a')
    assert.deepEqual(h.pending.list('s1').map((entry) => entry.id), ['later'])

    assert.equal(h.pending.claim('s1').id, 'later')
    assert.equal(h.pending.claim('s1'), null)
  } finally { h.done() }
})

test('pending：同一份稿子不会被认领第二次（先读后删，第二次得到 null）', () => {
  const h = harness()
  try {
    const item = h.pending.add('s1', { text: '唯一一条' })
    const a = h.pending.claim('s1')
    const b = h.pending.claim('s1')
    assert.equal(a.id, item.id)
    assert.equal(b, null)
    // 认领是「读文件 → 删条目 → 落盘」，中间态不落盘，所以不存在半认领
    assert.deepEqual(JSON.parse(readFileSync(h.file('s1'), 'utf8')).items, [])
  } finally { h.done() }
})

test('pending：带 messageId 认领后有回放账本——同一条消息再问还是那份稿子，队列不被二次消费', () => {
  const h = harness()
  try {
    h.pending.add('s1', { text: '第一条稿子', params: { emotion: 'happy' } })
    const claimed = h.pending.claim('s1', 'm1')
    assert.equal(claimed.text, '第一条稿子')
    // 队列已经空了，但账本按 messageId 记住它：同一条消息再问拿回同一份稿子
    assert.equal(h.pending.claim('s1', 'm1').text, '第一条稿子')
    assert.deepEqual(h.pending.claim('s1', 'm1').params, { emotion: 'happy' })
    // 别的消息没有账本条目，且不会顺手拿走已经认领过的那份稿子
    assert.equal(h.pending.claim('s1', 'm2'), null)

    // 新稿子取代队列，但账本不受影响：老消息重播老稿子，新消息拿新稿子
    h.pending.add('s1', { text: '第二条稿子' })
    assert.equal(h.pending.claim('s1', 'm1').text, '第一条稿子')
    assert.equal(h.pending.claim('s1', 'm2').text, '第二条稿子')
    assert.equal(h.pending.claim('s1', 'm2').text, '第二条稿子')

    const onDisk = JSON.parse(readFileSync(h.file('s1'), 'utf8'))
    assert.deepEqual(Object.keys(onDisk.delivered).sort(), ['m1', 'm2'])
    assert.deepEqual(onDisk.items, [])

    // 键来自客户端请求体：过量、空、原型链上的名字都不进账本
    assert.equal(h.pending.claim('s1', '__proto__'), null)
    assert.equal(h.pending.claim('s1', 'x'.repeat(200)), null)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(h.file('s1'), 'utf8')).delivered).sort(), ['m1', 'm2'])
  } finally { h.done() }
})

test('pending：不给 messageId 时行为不变（认领即消费，第二次 null，不留账本）', () => {
  const h = harness()
  try {
    h.pending.add('s1', { text: '无主稿子' })
    assert.equal(h.pending.claim('s1').text, '无主稿子')
    assert.equal(h.pending.claim('s1'), null)
    assert.deepEqual(JSON.parse(readFileSync(h.file('s1'), 'utf8')).delivered, {})
  } finally { h.done() }
})

test('pending：回放账本有上限，超出丢最旧（SPEC §11.5）', () => {
  const h = harness()
  try {
    for (let i = 0; i <= PENDING_DELIVERED_LIMIT; i += 1) {
      h.pending.add('s1', { text: `稿子 ${i}` })
      h.pending.claim('s1', `m${i}`)
    }
    const { delivered } = JSON.parse(readFileSync(h.file('s1'), 'utf8'))
    assert.equal(Object.keys(delivered).length, PENDING_DELIVERED_LIMIT)
    assert.equal(delivered.m0, undefined)
    assert.equal(delivered[`m${PENDING_DELIVERED_LIMIT}`].text, `稿子 ${PENDING_DELIVERED_LIMIT}`)
  } finally { h.done() }
})

test('pending：过期条目在下次读取时被清理，且落盘生效', () => {
  const h = harness()
  try {
    h.pending.add('s1', { text: '会过期的' })
    assert.equal(h.pending.list('s1').length, 1)
    clock.value += PENDING_TTL_MS + 1
    assert.deepEqual(h.pending.list('s1'), [])
    assert.deepEqual(JSON.parse(readFileSync(h.file('s1'), 'utf8')).items, [])
  } finally { h.done() }
})

test('pending：拿不到 sessionId 时走单文件降级 current.json', () => {
  const h = harness()
  try {
    const item = h.pending.add(undefined, { text: '无会话' })
    assert.equal(existsSync(join(h.dir, 'current.json')), true)
    assert.deepEqual(h.pending.list(undefined).map((entry) => entry.id), [item.id])
    assert.equal(h.pending.claim(undefined).id, item.id)
  } finally { h.done() }
})

test('pending：损坏文件自愈为默认结构', () => {
  const h = harness()
  try {
    h.pending.add('s1', { text: '先写一条' })
    writeFileSync(h.file('s1'), '这不是 JSON', 'utf8')
    const list = h.pending.list('s1')
    assert.deepEqual(list, [])
    // makeJsonStore 语义：读取时自愈为默认值、不改写主文件，损坏原文留作 .bak 证据
    assert.equal(readFileSync(h.file('s1'), 'utf8'), '这不是 JSON')
    assert.equal(readFileSync(`${h.file('s1')}.bak`, 'utf8'), '这不是 JSON')
    h.pending.add('s1', { text: '恢复后再写一条' })
    assert.equal(JSON.parse(readFileSync(h.file('s1'), 'utf8')).items.length, 1)
  } finally { h.done() }
})
