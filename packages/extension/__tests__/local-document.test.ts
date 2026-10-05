import { describe, expect, it } from 'vitest'
import { LOCAL_LIMITS, prepareLocalDocument, previewDocument, resolveLocalImage, sanitizeLocalHtml, type LocalFile } from '../src/lib/local-document'

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
function file(name: string, text = '', path = '', bytes?: Uint8Array): LocalFile {
  const content = bytes || new TextEncoder().encode(text)
  return { name, size: content.length, type: bytes ? 'image/png' : 'text/plain', webkitRelativePath: path, text: async () => text, arrayBuffer: async () => content.slice().buffer as ArrayBuffer }
}

describe('local Markdown import', () => {
  it('resolves Chinese relative and reference images without changing fenced/inline code', async () => {
    const source = '# 标题\n\n![图](图片/示意.png)\n\n![引用][图一]\n\n[图一]: 图片/%E7%A4%BA%E6%84%8F.png\n\n```c\n\tconst char *s = "![假](missing.png)";\n```\n\n`![行内](missing2.png)`\n\n[官网](https://example.com/path?q=1)'
    const doc = file('说明.md', source, '工程/说明.md')
    const image = file('示意.png', '', '工程/图片/示意.png', png)
    const result = await prepareLocalDocument(doc, [doc, image])
    expect(result.title).toBe('标题')
    expect(result.missingImages).toEqual([])
    expect(result.imageCount).toBe(2)
    expect(result.html).toContain('data:image/png;base64,')
    expect(result.markdown).toContain('```c\n\tconst char *s = "![假](missing.png)";\n```')
    expect(result.html).toContain('language-c')
    expect(result.markdown).toContain('`![行内](missing2.png)`')
    expect(result.html).toContain('https://example.com/path?q=1')
  })

  it('reports missing/ambiguous files instead of creating a syncable article', async () => {
    const doc = file('a.md', '![缺](none.png)\n![冲突](a/p.png)')
    const result = await prepareLocalDocument(doc, [file('p.png', '', '', png), file('p.png', '', '', png)])
    expect(result.missingImages).toEqual(['none.png', 'a/p.png'])
    expect(result.html).not.toContain('src="none.png"')
  })

  it('supports inline HTML images while skipping HTML inside code', async () => {
    const doc = file('a.md', '<img src="x.png" onerror="alert(1)">\n\n```html\n<img src="missing.png">\n```')
    const result = await prepareLocalDocument(doc, [file('x.png', '', '', png)])
    expect(result.missingImages).toEqual([])
    expect(result.imageCount).toBe(1)
    expect(result.html).not.toContain('onerror')
    expect(result.markdown).toContain('<img src="missing.png">')
  })

  it('enforces document, image, total and raster limits before upload', async () => {
    const large = { ...file('large.md'), size: LOCAL_LIMITS.text + 1 }
    await expect(prepareLocalDocument(large, [])).rejects.toThrow('5 MiB')
    const doc = file('a.md', '![图](x.png)')
    const image = { ...file('x.png', '', '', png), size: LOCAL_LIMITS.image + 1 }
    await expect(prepareLocalDocument(doc, [image])).rejects.toThrow('10 MiB')
    await expect(prepareLocalDocument(doc, [{ ...image, size: LOCAL_LIMITS.total + 1 }])).rejects.toThrow('50 MiB')
    await expect(prepareLocalDocument(file('a.md', '![图](x.svg)'), [file('x.svg', '<svg/>')])).rejects.toThrow('仅支持')
  })

  it('does not allow paths escaping a selected directory or arbitrary file URLs', () => {
    const doc = file('a.md', '', 'root/docs/a.md')
    const image = file('x.png', '', 'root/img/x.png', png)
    expect(resolveLocalImage('../img/x.png', doc, [image])).toBe(image)
    expect(resolveLocalImage('../../other/x.png', doc, [image])).toBeNull()
    expect(resolveLocalImage('file:///C:/x.png', doc, [image])).toBeNull()
    expect(resolveLocalImage('C:\\x.png', doc, [image])).toBeNull()
  })

  it('keeps remote images and warns that preview does not load them', async () => {
    const result = await prepareLocalDocument(file('a.md', '![远程](https://example.com/x.png)'), [])
    expect(result.html).toContain('https://example.com/x.png')
    expect(result.warnings.join()).toContain('离线预览')
    expect(previewDocument(result.html)).toContain("img-src data:")
  })

  it('removes unsafe links from Markdown as well as HTML', async () => {
    const result = await prepareLocalDocument(file('a.md', '[恶意](javascript:alert%281%29)\n\n[官网](https://example.com)'), [])
    expect(result.markdown).not.toContain('javascript:')
    expect(result.html).toContain('https://example.com')
  })

  it('handles nested image links without overlapping source edits', async () => {
    const result = await prepareLocalDocument(file('a.md', '[![图](x.png)](javascript:alert%281%29)\n\n尾段'), [file('x.png', '', '', png)])
    expect(result.markdown).not.toContain('javascript:')
    expect(result.markdown).toContain('尾段')
    expect(result.html).not.toContain('javascript:')
  })
})

describe('safe local HTML', () => {
  it('removes script, active embeds, event/style attributes and unsafe URLs', async () => {
    const html = await sanitizeLocalHtml('<script>alert(1)</script><iframe src="https://evil.test"></iframe><p onclick="x()" style="background:url(https://evil.test)">正文</p><a href="javascript:alert(1)">危险</a><img src="x.png" onerror="x()"><pre><code class="language-c">a &lt; b</code></pre>', async () => 'data:image/png;base64,iVBORw0KGgo=')
    expect(html).not.toMatch(/script|iframe|onclick|onerror|style=|javascript:|evil\.test/)
    expect(html).toContain('正文')
    expect(html).toContain('language-c')
    expect(html).toContain('a &lt; b')
  })

  it('retains HTML title and local image content', async () => {
    const doc = file('a.html', '<!doctype html><html><head><title>HTML标题</title></head><body><h1>正文</h1><img src="x.png"></body></html>')
    const result = await prepareLocalDocument(doc, [file('x.png', '', '', png)])
    expect(result.title).toBe('HTML标题')
    expect(result.html).toContain('data:image/png;base64,')
    expect(result.markdown).toBeUndefined()
  })
})
