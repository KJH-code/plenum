// 세션 화면 작은 함수: 지난 카드 글(answeredLabel), 이어할 세션(resumeTarget)
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { answeredLabel, ModelChip, resumeTarget } from '../web/src/Chat.tsx';

it('지난 카드: outcome 으로 접두어를 고른다, 없으면(옛 서버) summary 그대로', () => {
  expect(answeredLabel({ summary: 'a.txt', outcome: 'answered' })).toBe('답함: a.txt');
  expect(answeredLabel({ summary: 'Bash rm a.txt', outcome: 'denied' })).toBe('거부함: Bash rm a.txt');
  expect(answeredLabel({ summary: '답함: a.txt' })).toBe('답함: a.txt');
  expect(answeredLabel({ summary: '' , outcome: 'answered' })).toBe('답함: ');
});

it('이어할 세션: 지난 세션 ID 가 먼저(채팅이 init 전에 끝나 세션 ID 가 없어도), 없으면 채팅 세션, 둘 다 없으면 null', () => {
  const A = 'aaaaaaaa-1111-4222-8333-444444444444';
  const B = 'bbbbbbbb-1111-4222-8333-444444444444';
  expect(resumeTarget(A, null)).toBe(A);
  expect(resumeTarget(A, B)).toBe(A);
  expect(resumeTarget(null, B)).toBe(B);
  expect(resumeTarget(null, null)).toBeNull();
});

it('모델 칩: 워커 표·작동 중이 같이 쓴다. 모델 이름에 맞는 색 클래스, null 이면 안 그린다', () => {
  expect(renderToStaticMarkup(createElement(ModelChip, { model: 'haiku' }))).toBe('<span class="chip haiku" data-testid="model-chip">haiku</span>');
  expect(renderToStaticMarkup(createElement(ModelChip, { model: 'claude-opus-5-5' }))).toContain('class="chip opus"');
  expect(renderToStaticMarkup(createElement(ModelChip, { model: 'inherit' }))).toBe('<span class="chip " data-testid="model-chip">inherit</span>');
  expect(renderToStaticMarkup(createElement(ModelChip, { model: null }))).toBe('');
  expect(renderToStaticMarkup(createElement(ModelChip, { model: '' }))).toBe('');
});
