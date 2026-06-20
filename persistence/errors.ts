export class PersistenceError extends Error {
  override readonly name: string = 'PersistenceError'

  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message)
  }
}

export class BusyRetryExhaustedError extends PersistenceError {
  override readonly name: string = 'BusyRetryExhaustedError'

  constructor(
    readonly attempts: number,
    cause: unknown,
  ) {
    super(`SQLITE_BUSY: exhausted ${attempts} retries`, cause)
  }
}
