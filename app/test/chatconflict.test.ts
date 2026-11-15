// 세션 화면 409 분기(conflictAction): 서버 본문 reason 으로만 고른다
import { expect, it } from 'vitest';
import { ApiError } from '../web/src/api.ts';
import { conflictAction } from '../web/src/Chat.tsx';

const err409 = (data: any) => new ApiError(data.error ?? '충돌', 409, data);
const SID = 'b5b49096-5604-499f-a80b-49f35d8d09bb';

it('awaiting-card → 본문 chatId 로 그 채팅으로 가기, chatId 가 없으면 오류 문구만', () => {
  const e = err409({ error: '답을 기다리는 카드가 있다', reason: 'awaiting-card', chatId: 'c-1' });
  expect(e.reason).toBe('awaiting-card');
  expect(e.chatId).toBe('c-1');
  expect(conflictAction(e, SID)).toEqual({ kind: 'go-chat', chatId: 'c-1', message: '답을 기다리는 카드가 있다' });
  expect(conflictAction(e, null)).toEqual({ kind: 'go-chat', chatId: 'c-1', message: '답을 기다리는 카드가 있다' });
  expect(conflictAction(err409({ error: 'x', reason: 'awaiting-card' }), SID)).toEqual({ kind: 'error', message: 'x' });
});

it('terminal-open → 이미 닫았다(이어할 세션), 세션이 없으면 오류 문구만', () => {
  const e = err409({ error: '터미널에서 열려 있다', reason: 'terminal-open' });
  expect(conflictAction(e, SID)).toEqual({ kind: 'terminal', sid: SID });
  expect(conflictAction(e, null)).toEqual({ kind: 'error', message: '터미널에서 열려 있다' });
});

it('chat-ended → ended, card-answered·모르는 reason·reason 없음 → 오류 문구만', () => {
  expect(conflictAction(err409({ error: '채팅이 끝났다', reason: 'chat-ended' }), SID)).toEqual({ kind: 'ended', message: '채팅이 끝났다' });
  expect(conflictAction(err409({ error: '이미 답한 카드', reason: 'card-answered' }), SID)).toEqual({ kind: 'error', message: '이미 답한 카드' });
  expect(conflictAction(err409({ error: '?', reason: 'new-thing' }), SID)).toEqual({ kind: 'error', message: '?' });
  // 예전처럼 reason 없는 409 는 세션이 있어도 터미널·카드로 추측하지 않는다
  expect(conflictAction(err409({ error: '이미 목록에 있다' }), SID)).toEqual({ kind: 'error', message: '이미 목록에 있다' });
  expect(conflictAction(new ApiError('엉뚱', 409, null), SID)).toEqual({ kind: 'error', message: '엉뚱' });
});

it('409 가 아니거나 ApiError 가 아니면 null', () => {
  expect(conflictAction(new ApiError('없음', 404, { error: '없음', reason: 'chat-ended' }), SID)).toBeNull();
  expect(conflictAction(new Error('x'), SID)).toBeNull();
  expect(conflictAction(undefined, SID)).toBeNull();
});
