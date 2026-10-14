import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { CUE_TAGS, cleanForTts } from '../lib/core.js'

/** SPEC §8 的 19 个语气词标签（仅 2.8-hd / turbo 支持），清洗必须一个不落地保留。 */
const SPEC_CUE_TAGS = [
  'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant', 'inhale', 'exhale', 'gasps',
  'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes',
]

test('cleanForTts：去代码围栏与行内代码', () => {
  assert.equal(cleanForTts('```js\nconst a = 1\n```'), '')
  assert.equal(cleanForTts('看 `code` 呢'), '看 呢')
  assert.equal(cleanForTts('~~~\nnpm i\n~~~\n尾巴'), '尾巴')
})

test('cleanForTts：去 URL、保留链接文字、保留图片 alt', () => {
  assert.equal(cleanForTts('来看 https://example.com/a?b=1 吧'), '来看 吧')
  assert.equal(cleanForTts('点 [链接](https://x.com) 呀'), '点 链接 呀')
  assert.equal(cleanForTts('![图](https://x.com/i.png)'), '图')
  assert.equal(cleanForTts('裸域名 example.com 不是 URL 规则的对象'), '裸域名 example.com 不是 URL 规则的对象')
})

test('cleanForTts：去绝对路径、相对路径与 ~ 路径', () => {
  assert.equal(cleanForTts('打开 /Users/x/a.md 和 ./rel/d.txt 与 ~/b/c.js'), '打开 和 与')
  assert.equal(cleanForTts('/usr/local/bin/node 在跑'), '在跑')
})

test('cleanForTts：去 emoji 与颜文字装饰，去 Markdown 装饰符', () => {
  assert.equal(cleanForTts('尾巴 🎉🚀 前缀'), '尾巴 前缀')
  assert.equal(cleanForTts('# 标题\n\n**正文**'), '标题\n\n正文')
  assert.equal(cleanForTts('> 引用'), '引用')
  assert.equal(cleanForTts('~~删除~~'), '删除')
  assert.equal(cleanForTts('| a | b |\n|---|---|\n| 1 | 2 |'), 'a b\n\n1 2')
  assert.equal(cleanForTts('***'), '')
})

test('cleanForTts：强保留 19 个语气词标签（与 SPEC §8 清单逐一比对）', () => {
  assert.deepEqual([...CUE_TAGS].sort(), [...SPEC_CUE_TAGS].sort())
  assert.equal(CUE_TAGS.length, 19)
  for (const tag of SPEC_CUE_TAGS) {
    const cleaned = cleanForTts(`前面 (${tag}) 后面`)
    assert.match(cleaned, new RegExp(`\\(${tag}\\)`), `语气词标签 (${tag}) 被清洗掉了`)
    assert.match(cleaned, /前面/)
    assert.match(cleaned, /后面/)
  }
})

test('cleanForTts：强保留停顿标记 <#x#>', () => {
  assert.equal(cleanForTts('哈哈 (laughs) 然后 <#0.8#> 停 (sighs)'), '哈哈 (laughs) 然后 <#0.8#> 停 (sighs)')
  assert.match(cleanForTts('一 <#0.01#> 二'), /<#0\.01#>/)
  assert.match(cleanForTts('一 <#99.99#> 二'), /<#99\.99#>/)
})

test('cleanForTts：强保留行内注音 (chu3)(li3)', () => {
  assert.equal(cleanForTts('处理 (chu3)(li3) 危险'), '处理 (chu3)(li3) 危险')
})

test('cleanForTts：压缩连续空白、保留段落换行', () => {
  assert.equal(cleanForTts('a  \n\n\n  b'), 'a\n\nb')
  assert.equal(cleanForTts('第一段\n\n第二段'), '第一段\n\n第二段')
  assert.equal(cleanForTts('  \t 多   空格  '), '多 空格')
})

test('cleanForTts：清洗后为空的各种来源', () => {
  for (const input of ['', '   \n  ', 'https://example.com/only', '/Users/shiro/x', '```\n```', '🎉🚀', '***', '[](https://x.com)']) {
    assert.equal(cleanForTts(input), '', `未被清空: ${JSON.stringify(input)}`)
  }
  assert.equal(cleanForTts('(laughs)'), '(laughs)')
})

test('cleanForTts：非字符串输入不抛异常', () => {
  for (const input of [undefined, null, 42, {}, []]) assert.equal(cleanForTts(input), '')
})

const corpusDir = fileURLToPath(new URL('./corpus/', import.meta.url))

for (const bin of ['filtered', 'dropped']) {
  test(`corpus/${bin}：每份语料清洗后为空`, () => {
    const dir = join(corpusDir, bin)
    const names = existsSync(dir)
      ? readdirSync(dir).filter((name) => !name.startsWith('.') && !name.startsWith('_'))
      : []
    assert.ok(names.length > 0, `corpus/${bin} 里没有语料文件`)
    for (const name of names) {
      const content = readFileSync(join(dir, name), 'utf8')
      assert.equal(cleanForTts(content).trim(), '', `corpus/${bin}/${name} 未被清空`)
    }
  })
}
