// 채팅 마크다운 파서 (web/src/markdown.ts). HTML·위험한 링크는 글자로만 나와야 한다.
import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown, type Block, type Inline } from '../web/src/markdown.ts';

// 트리 안의 모든 노드 종류
function kinds(bs: Block[]): string[] {
  const out: string[] = [];
  const inl = (ns: Inline[]) => { for (const n of ns) { out.push(`i:${n.t}`); if ('c' in n) inl(n.c); } };
  const blk = (b: Block) => {
    out.push(`b:${b.t}`);
    if (b.t === 'p' || b.t === 'h') inl(b.c);
    if (b.t === 'quote') b.c.forEach(blk);
    if (b.t === 'list') b.items.forEach((it) => { inl(it.c); if (it.sub) blk(it.sub); });
    if (b.t === 'table') { b.head.forEach(inl); b.rows.forEach((r) => r.forEach(inl)); }
  };
  bs.forEach(blk);
  return out;
}

describe('위험한 입력은 글자로', () => {
  it('<script> 는 text 노드 하나', () => {
    expect(parseMarkdown('<script>alert(1)</script>')).toEqual([{ t: 'p', c: [{ t: 'text', v: '<script>alert(1)</script>' }] }]);
  });
  it('<img onerror> 도 글자 그대로', () => {
    const s = '<img src=x onerror="alert(1)">';
    expect(parseMarkdown(s)).toEqual([{ t: 'p', c: [{ t: 'text', v: s }] }]);
  });
  it('javascript: 링크는 링크 노드 없이 글자', () => {
    expect(parseMarkdown('[x](javascript:alert(1))')).toEqual([{ t: 'p', c: [{ t: 'text', v: '[x](javascript:alert(1))' }] }]);
    for (const s of ['[x](JavaScript:alert(1))', '[x](data:text/html,hi)', '[x](//evil.example)', '[x](vbscript:x)']) {
      expect(kinds(parseMarkdown(s)), s).not.toContain('i:link');
    }
  });
  it('http·https 링크만 링크 노드', () => {
    expect(parseInline('보기 [문서](https://example.com/a?b=1) 끝')).toEqual([
      { t: 'text', v: '보기 ' }, { t: 'link', href: 'https://example.com/a?b=1', c: [{ t: 'text', v: '문서' }] }, { t: 'text', v: ' 끝' },
    ]);
    expect(parseInline('[a](http://x.y)')[0]).toMatchObject({ t: 'link', href: 'http://x.y' });
  });
  it('코드 블록 안 HTML 도 글자', () => {
    expect(parseMarkdown('```html\n<script>x</script>\n```')).toEqual([{ t: 'code', lang: 'html', v: '<script>x</script>' }]);
  });
});

describe('기대 트리', () => {
  it('굵게·기울임·인라인 코드·줄바꿈', () => {
    expect(parseMarkdown('**굵게** 와 *기울임* 과 `a < b`\n다음 줄')).toEqual([{ t: 'p', c: [
      { t: 'strong', c: [{ t: 'text', v: '굵게' }] }, { t: 'text', v: ' 와 ' },
      { t: 'em', c: [{ t: 'text', v: '기울임' }] }, { t: 'text', v: ' 과 ' },
      { t: 'code', v: 'a < b' }, { t: 'br' }, { t: 'text', v: '다음 줄' },
    ] }]);
  });
  it('단락은 빈 줄로 나뉜다', () => {
    expect(parseMarkdown('하나\n\n둘').map((b) => b.t)).toEqual(['p', 'p']);
  });
  it('코드 블록(언어)', () => {
    expect(parseMarkdown('앞\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n뒤')).toEqual([
      { t: 'p', c: [{ t: 'text', v: '앞' }] },
      { t: 'code', lang: 'ts', v: 'const a = 1;\n\nconst b = 2;' },
      { t: 'p', c: [{ t: 'text', v: '뒤' }] },
    ]);
  });
  it('닫히지 않은 ``` 는 끝까지 코드로, 죽지 않는다', () => {
    expect(parseMarkdown('```\nabc\n**x**')).toEqual([{ t: 'code', lang: '', v: 'abc\n**x**' }]);
    expect(parseMarkdown('```')).toEqual([{ t: 'code', lang: '', v: '' }]);
    expect(parseInline('`열린 코드')).toEqual([{ t: 'text', v: '`열린 코드' }]);
    expect(parseInline('**안 닫힌 굵게')).toEqual([{ t: 'text', v: '**안 닫힌 굵게' }]);
  });
  it('목록: -·*·1. 과 한 단계 중첩', () => {
    expect(parseMarkdown('- 하나 **굵게**\n  - 안쪽 1\n  - 안쪽 2\n* 둘')).toEqual([{ t: 'list', ordered: false, items: [
      { c: [{ t: 'text', v: '하나 ' }, { t: 'strong', c: [{ t: 'text', v: '굵게' }] }], sub: { t: 'list', ordered: false, items: [
        { c: [{ t: 'text', v: '안쪽 1' }], sub: null }, { c: [{ t: 'text', v: '안쪽 2' }], sub: null },
      ] } },
      { c: [{ t: 'text', v: '둘' }], sub: null },
    ] }]);
    expect(parseMarkdown('1. 가\n2. 나')).toEqual([{ t: 'list', ordered: true, items: [
      { c: [{ t: 'text', v: '가' }], sub: null }, { c: [{ t: 'text', v: '나' }], sub: null },
    ] }]);
  });
  it('표: 머리 줄 + 구분 줄, 셀 안 인라인 서식', () => {
    expect(parseMarkdown('| 이름 | 값 |\n|---|:---:|\n| `a` | **1** |\n| b |')).toEqual([{ t: 'table',
      head: [[{ t: 'text', v: '이름' }], [{ t: 'text', v: '값' }]],
      rows: [
        [[{ t: 'code', v: 'a' }], [{ t: 'strong', c: [{ t: 'text', v: '1' }] }]],
        [[{ t: 'text', v: 'b' }], []],
      ] }]);
  });
  it('구분 줄 없는 | 는 단락', () => {
    expect(parseMarkdown('a | b')).toEqual([{ t: 'p', c: [{ t: 'text', v: 'a | b' }] }]);
  });
  it('제목·인용', () => {
    expect(parseMarkdown('## 제목 *강조*\n> 인용 **굵게**\n> 둘째 줄')).toEqual([
      { t: 'h', level: 2, c: [{ t: 'text', v: '제목 ' }, { t: 'em', c: [{ t: 'text', v: '강조' }] }] },
      { t: 'quote', c: [{ t: 'p', c: [{ t: 'text', v: '인용 ' }, { t: 'strong', c: [{ t: 'text', v: '굵게' }] }, { t: 'br' }, { t: 'text', v: '둘째 줄' }] }] },
    ]);
  });
  it('모르는 것·빈 입력', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('~~취소~~ ==형광==')).toEqual([{ t: 'p', c: [{ t: 'text', v: '~~취소~~ ==형광==' }] }]);
    expect(parseMarkdown('2 * 3 * 4')).toEqual([{ t: 'p', c: [{ t: 'text', v: '2 * 3 * 4' }] }]);
  });
  it('녹화 01 끝 메시지 모양', () => {
    const k = kinds(parseMarkdown('Not done: step 5 failed. The other steps ran.\n\n- **Step 1:** You chose `a.txt`.\n- **Step 2:** `touch a.txt` succeeded.'));
    expect(k.filter((x) => x.startsWith('b:'))).toEqual(['b:p', 'b:list']);
    expect(k).toContain('i:strong');
    expect(k).toContain('i:code');
  });
});
