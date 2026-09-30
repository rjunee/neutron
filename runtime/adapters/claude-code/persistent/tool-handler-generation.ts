/** Host-authenticated identity; never accepted from model arguments. */
export interface ClaudeToolGeneration {
  sessionId: string
  childGeneration: string
  /** null is General; undefined has no authenticated scope and must refuse. */
  projectId: string | null | undefined
  admissionGeneration: number | undefined
  /** Adopted parents without a pre-existing ledger have incomplete historical coverage. */
  adopted: boolean
}

export interface ClaudeToolHandlerAdmission {
  dispatch<T>(identity: ClaudeToolGeneration, invocationId: string, binding: string,
    current: () => boolean, handler: () => Promise<T>): Promise<T>
}
