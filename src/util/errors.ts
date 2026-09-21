// Exit codes documented in README.md. Keep stable: agents depend on them.
export const ExitCode = {
  ok: 0,
  failure: 1,
  usage: 2,
  authFailure: 3,
  conflictNeedsHerdr: 4,
  branchUpdateFailed: 5,
  blocked: 6,
  prClosed: 7,
} as const;

export type ExitCodeName = keyof typeof ExitCode;

export class PrbbError extends Error {
  readonly exitCode: number;
  readonly code: ExitCodeName;

  constructor(message: string, code: ExitCodeName = "failure") {
    super(message);
    this.name = "PrbbError";
    this.code = code;
    this.exitCode = ExitCode[code];
  }
}

export function fail(message: string, code: ExitCodeName = "failure"): never {
  throw new PrbbError(message, code);
}
