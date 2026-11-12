export class UserError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
