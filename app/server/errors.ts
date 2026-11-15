// reason: 화면이 분기에 쓰는 기계용 이유(선택). extra: 본문에 같이 실을 칸(예: 이동할 chatId)
export class UserError extends Error {
  constructor(public status: number, message: string, public reason?: string, public extra?: Record<string, string>) { super(message); }
}
