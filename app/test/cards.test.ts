// 승인 카드 본문: 입력에 문자열 command 가 있는 도구(Bash·PowerShell 등)는 명령 코드 블록 + 설명 줄
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PermissionCard } from '../web/src/Cards.tsx';
import type { Card } from '../server/chatTypes.ts';

type Perm = Extract<Card, { kind: 'permission' }>;
const render = (toolName: string, input: unknown, extra: Partial<Perm> = {}) => renderToStaticMarkup(createElement(PermissionCard, {
  card: { kind: 'permission', requestId: 'r-1', toolName, input, sessionRules: [], ...extra },
  resolved: null, cwd: 'C:\\Users\\홍길동\\프로젝트', onReply: async () => {},
}));
const codeOf = (html: string) => /<code class="cmd">([\s\S]*?)<\/code>/.exec(html)?.[1] ?? null;

it.each(['PowerShell', 'Bash'])('%s {command, description} → 명령 코드 블록 + 설명 줄, JSON 덩어리 없음', (tool) => {
  const html = render(tool, { command: 'Get-ChildItem -Force', description: '숨긴 파일까지 목록' });
  expect(codeOf(html)).toBe('Get-ChildItem -Force');
  expect(html).toContain('명령을 실행해도 될까?');
  expect(html).toContain(`${tool} · 숨긴 파일까지 목록 · 작업 폴더`);
  expect(html).not.toContain('&quot;command&quot;');
  expect(html).not.toContain('{');
});

it('요청의 description 이 있으면 그것이 먼저, 입력 description 은 겹쳐 쓰지 않는다', () => {
  const html = render('PowerShell', { command: 'ls', description: '입력 설명' }, { description: '요청 설명' });
  expect(html).toContain('PowerShell · 요청 설명 · 작업 폴더');
  expect(html).not.toContain('입력 설명');
});

it('command 가 문자열이 아니면 명령 카드가 아니다(제목·JSON 그대로)', () => {
  const html = render('PowerShell', { command: ['ls'] });
  expect(html).toContain('PowerShell 도구를 써도 될까?');
  expect(codeOf(html)).toContain('&quot;command&quot;');
});

it('빈 command 도 명령 카드(빈 코드 블록), file_path 도구는 그대로 경로', () => {
  expect(codeOf(render('PowerShell', { command: '' }))).toBe('');
  const w = render('Write', { file_path: 'C:\\a\\b.txt', content: 'x' });
  expect(w).toContain('파일을 써도 될까?');
  expect(codeOf(w)).toBe('C:\\a\\b.txt');
});
