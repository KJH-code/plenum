// 세션 화면 작은 함수: 지난 카드 글(answeredLabel)
import { expect, it } from 'vitest';
import { answeredLabel } from '../web/src/Chat.tsx';

it('지난 카드: outcome 으로 접두어를 고른다, 없으면(옛 서버) summary 그대로', () => {
  expect(answeredLabel({ summary: 'a.txt', outcome: 'answered' })).toBe('답함: a.txt');
  expect(answeredLabel({ summary: 'Bash rm a.txt', outcome: 'denied' })).toBe('거부함: Bash rm a.txt');
  expect(answeredLabel({ summary: '답함: a.txt' })).toBe('답함: a.txt');
  expect(answeredLabel({ summary: '' , outcome: 'answered' })).toBe('답함: ');
});
