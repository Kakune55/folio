import { describe, expect, it } from 'vitest'
import { commonmarkLanguage, markdown } from '@codemirror/lang-markdown'
import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { GFM } from '@lezer/markdown'
import { decodeMarkdownTarget, markdownLinkAt, markdownLinkTarget, markdownReferences } from './links'

function stateFor(doc: string) {
  return EditorState.create({ doc, extensions: markdown({ base: commonmarkLanguage, extensions: GFM }) })
}

describe('Markdown 引用跳转', () => {
  it('识别链接、图片、带空格路径与引用式链接', () => {
    for (const source of ['[打开](./目标%20文件.md)', '![打开](./图片.png)', '[打开](<./目标 文件.md>)', '[打开][REF]\n\n[ref]: ./目标.md', '[打开][]\n\n[打开]: ./目标.md', '[打开]\n\n[打开]: ./目标.md']) {
      expect(markdownLinkAt(source, source.indexOf('打开') + 1)).toMatch(/^\.\//)
    }
    expect(markdownLinkAt('[打开](./a\\(b\\).md)', 2)).toBe('./a(b).md')
  })
  it('代码中的伪引用与普通文字不触发跳转', () => {
    for (const source of ['`[打开](./目标.md)`', '```md\n[打开](./目标.md)\n```', '    [打开](./目标.md)', '普通文字打开', '[打开][不存在]']) {
      expect(markdownLinkAt(source, source.indexOf('打开') + 1)).toBeUndefined()
    }
  })

  it.each([
    ['https://example.com/a?b=1&c=2', 'https://example.com/a?b=1&c=2'],
    ['http://example.com', 'http://example.com'],
    ['www.example.com/a', 'https://www.example.com/a'],
    ['<https://example.com/a>', 'https://example.com/a'],
    ['<mailto:user@example.com>', 'mailto:user@example.com'],
    ['<user@example.com>', 'mailto:user@example.com'],
    ['[打开](./a\\(b\\).md?x=1&amp;y=&#50;)', './a(b).md?x=1&y=2'],
  ])('原 API 解析自动链接与目标解码：%s', (source, expected) => {
    expect(markdownLinkAt(source, Math.floor(source.length / 2))).toBe(expected)
  })

  it('未定义引用不会返回标签或内部裸 URL', () => {
    for (const source of ['[https://example.com][不存在]', '[www.example.com]', '[打开][]', '[打开]']) {
      expect(markdownLinkAt(source, source.indexOf('[') + 3)).toBeUndefined()
    }
    const source = '[打开](https://example.com)'
    expect(markdownLinkAt(source, source.indexOf('example') + 2)).toBe('https://example.com')
  })

  it('非法位置、超字符预算与无链接边界保守返回 undefined', () => {
    const source = '[打开](./目标.md) 后文'
    for (const position of [-1, 1.5, NaN, Infinity, source.length + 1, source.length]) {
      expect(markdownLinkAt(source, position)).toBeUndefined()
    }
    expect(markdownLinkAt(' '.repeat(100001) + source, 100003)).toBeUndefined()
    expect(markdownLinkAt('', 0)).toBeUndefined()
    expect(markdownLinkAt('[打开](<未闭合)', 2)).toBeUndefined()
  })

  it('保留原始 CRLF 位置，首字符也能命中裸链接', () => {
    const source = '前文\r\n\r\n[打开](./目标.md)'
    expect(markdownLinkAt(source, source.indexOf('打开') + 1)).toBe('./目标.md')
    expect(markdownLinkAt('https://example.com', 0)).toBe('https://example.com')
  })
})

describe('共享语法节点链接 API', () => {
  it.each([
    ['[打开][ My  REF ]\n\n[my ref]: <./a&amp;b.md>', './a&b.md'],
    ['[打开][]\n\n[打开]: ./目标.md', './目标.md'],
    ['[打开]\n\n[打开]: ./目标.md', './目标.md'],
    ['![打开][图]\n\n[图]: ./图.png', './图.png'],
    ['[a\\]b]\n\n[a\\]b]: ./转义.md', './转义.md'],
    ['[*打开*]\n\n[*打开*]: ./强调.md', './强调.md'],
    ['[https://example.com][ref]\n\n[ref]: ./引用.md', './引用.md'],
    ['[打开]()\n\n[打开]: ./不可回退.md', ''],
    ['[打开][不存在]', undefined],
    ['[打开]', undefined],
  ])('按节点范围解析引用：%s', (source, expected) => {
    const state = stateFor(source)
    const node = syntaxTree(state).resolveInner(3, -1)
    expect(markdownLinkTarget(state, node)).toBe(expected)
    expect(markdownLinkTarget(state, node, markdownReferences(state))).toBe(expected)
    expect(state.doc.toString()).toBe(source)
  })

  it('读取 Link、Image、Autolink 和 URL 节点；内联目标 URL 不擅自补协议', () => {
    for (const source of ['[打开](www.example.com)', '![打开](www.example.com)', '<https://example.com>', 'www.example.com']) {
      const state = stateFor(source)
      const tree = syntaxTree(state)
      const url = tree.topNode.firstChild!.firstChild!
      const expected = source.startsWith('www.') ? 'https://www.example.com' : source.startsWith('<') ? 'https://example.com' : 'www.example.com'
      expect(markdownLinkTarget(state, url)).toBe(expected)
      const target = tree.resolveInner(source.indexOf('example') + 2, -1)
      expect(target.name).toBe('URL')
      expect(markdownLinkTarget(state, target)).toBe(expected)
    }
    const state = stateFor('[https://label.example](https://target.example)')
    const node = syntaxTree(state).resolveInner(10, -1)
    expect(markdownLinkTarget(state, node)).toBe('https://target.example')
  })

  it('引用表规范化空白和大小写、首定义优先，排除代码内定义', () => {
    const source = '[ My\n REF ]: ./first&amp;x.md\n\n[my ref]: ./second.md\n\n```md\n[code]: ./bad.md\n```\n\n    [indent]: ./bad.md\n\n`[inline]: ./bad.md`'
    expect([...markdownReferences(stateFor(source))]).toEqual([['my ref', './first&x.md']])
    expect(markdownReferences(EditorState.create({ doc: '[ref]: ./未解析.md' })).size).toBe(0)
  })

  it('显式传入空引用表时不重新扫描定义', () => {
    const state = stateFor('[打开][ref]\n\n[ref]: ./目标.md')
    const node = syntaxTree(state).resolveInner(2, -1)
    expect(markdownLinkTarget(state, node, new Map())).toBeUndefined()
    expect(markdownLinkTarget(state, node, new Map([['ref', './缓存.md']]))).toBe('./缓存.md')
  })

  it('代码块即使注入 Markdown 子语言也不贡献引用', () => {
    const nested = markdown({ base: commonmarkLanguage, extensions: GFM })
    const state = EditorState.create({
      doc: '```md\n[hidden]: ./代码内.md\n\n[打开](https://example.com)\n```\n\n[visible]: ./正文.md',
      extensions: markdown({ base: commonmarkLanguage, extensions: GFM, codeLanguages: () => nested.language }),
    })
    expect([...markdownReferences(state)]).toEqual([['visible', './正文.md']])
    expect(markdownLinkTarget(state, syntaxTree(state).resolveInner(state.doc.toString().indexOf('example') + 1, -1))).toBeUndefined()
  })

  it.each(['`https://example.com`', '```md\nhttps://example.com\n```', '    https://example.com', '[ref]: https://example.com'])('代码及引用定义内 URL 不是跳转节点：%s', (source) => {
    const state = stateFor(source)
    expect(markdownLinkTarget(state, syntaxTree(state).resolveInner(source.indexOf('example') + 1, -1))).toBeUndefined()
  })

  it('字符预算之外、超节点预算之后的引用不参与解析', () => {
    const source = '[early]: ./早.md\n\n' + '文本 '.repeat(34000) + '\n\n[late]: ./晚.md'
    expect([...markdownReferences(stateFor(source))]).toEqual([['early', './早.md']])
    const dense = '*x* '.repeat(1500) + '\n\n[late]: ./晚.md'
    expect(markdownReferences(stateFor(dense)).has('late')).toBe(false)
    const state = stateFor(' '.repeat(100001) + '[打开](./目标.md)')
    const node = markdown({ base: commonmarkLanguage, extensions: GFM }).language.parser.parse(state.doc.toString()).resolveInner(100004, -1)
    expect(markdownLinkTarget(state, node)).toBeUndefined()
  })
})

describe('Markdown 目标纯文本解码', () => {
  it.each([
    ['<./a b.md>', './a b.md'],
    ['./a\\(b\\)\\!\\_\\[c\\].md', './a(b)!_[c].md'],
    ['./a\\nb%20c.md', './a\\nb%20c.md'],
    ['?a=&amp;&quot;&apos;&lt;&gt;', '?a=&"\'<>'],
    ['&#65;&#x1f600;&#X42;&#0;&#55296;&#1114112;', 'A\u{1f600}B\ufffd\ufffd\ufffd'],
    ['&unknown;&copy;&#xZZ;', '&unknown;&copy;&#xZZ;'],
    ['&amp;lt;\\&amp;', '&lt;&amp;'],
    ['&lt;img src=x onerror=alert(1)&gt;', '<img src=x onerror=alert(1)>'],
    ['javascript&#58;alert(1)', 'javascript:alert(1)'],
  ])('不执行 HTML、不递归解码：%s', (raw, expected) => {
    expect(decodeMarkdownTarget(raw)).toBe(expected)
  })
})
