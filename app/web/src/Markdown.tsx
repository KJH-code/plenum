import { useMemo, type ReactNode } from 'react';
import { parseMarkdown, type Block, type Inline } from './markdown';

// markdown.ts 트리 → React 요소. 글자는 모두 React 가 이스케이프한다(HTML 을 끼워 넣지 않는다)
function inlines(ns: Inline[]): ReactNode[] {
  return ns.map((n, i) => {
    switch (n.t) {
      case 'text': return n.v;
      case 'br': return <br key={i} />;
      case 'code': return <code key={i} className="md-code">{n.v}</code>;
      case 'strong': return <strong key={i}>{inlines(n.c)}</strong>;
      case 'em': return <em key={i}>{inlines(n.c)}</em>;
      case 'link': return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer">{inlines(n.c)}</a>;
    }
  });
}

function block(b: Block, i: number): ReactNode {
  switch (b.t) {
    case 'p': return <p key={i}>{inlines(b.c)}</p>;
    case 'h': return <h4 key={i}>{inlines(b.c)}</h4>;
    case 'code':
      return (
        <div key={i} className="md-pre">
          {b.lang && <span className="md-lang">{b.lang}</span>}
          <pre><code>{b.v}</code></pre>
        </div>
      );
    case 'quote': return <blockquote key={i}>{b.c.map(block)}</blockquote>;
    case 'list': {
      const items = b.items.map((it, k) => <li key={k}>{inlines(it.c)}{it.sub && block(it.sub, 0)}</li>);
      return b.ordered ? <ol key={i}>{items}</ol> : <ul key={i}>{items}</ul>;
    }
    case 'table':
      return (
        <div key={i} className="md-table">
          <table>
            <thead><tr>{b.head.map((c, k) => <th key={k}>{inlines(c)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inlines(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      );
  }
}

export function Markdown({ text }: { text: string }) {
  const tree = useMemo(() => parseMarkdown(text), [text]);
  return <div className="md">{tree.map(block)}</div>;
}
