type ObjectValue = Record<string, unknown>
const object = (value: unknown): value is ObjectValue => typeof value === 'object' && value !== null && !Array.isArray(value)

// Scope-bearing protocol nodes from Codex 0.154.0's generated app-server schema.
// Traverse these nodes, not arbitrary JSON in user input, metadata or outputSchema.
type ScopeNode = 'request' | 'environment' | 'sandbox'
const mutationFields: Readonly<Record<string, readonly string[]>> = {
  'turn/start': ['threadId', 'clientUserMessageId', 'input', 'turnTrigger', 'toolOutput', 'responsesapiClientMetadata',
    'additionalContext', 'environments', 'cwd', 'runtimeWorkspaceRoots', 'approvalPolicy', 'approvalsReviewer',
    'sandboxPolicy', 'permissions', 'model', 'serviceTier', 'serviceTierForTurn', 'effort', 'summary', 'personality',
    'outputSchema', 'collaborationMode', 'multiAgentMode', 'cyberAccessProgram'],
  'thread/settings/update': ['threadId', 'cwd', 'approvalPolicy', 'approvalsReviewer', 'sandboxPolicy', 'permissions',
    'model', 'serviceTier', 'effort', 'summary', 'collaborationMode', 'multiAgentMode', 'personality'],
  'thread/resume': ['threadId', 'history', 'path', 'model', 'modelProvider', 'serviceTier', 'cwd', 'runtimeWorkspaceRoots',
    'approvalPolicy', 'approvalsReviewer', 'sandbox', 'permissions', 'config', 'baseInstructions', 'developerInstructions',
    'personality', 'excludeTurns', 'initialTurnsPage'],
  'turn/interrupt': ['threadId', 'turnId'],
  'config/batchWrite': ['edits', 'filePath', 'expectedVersion', 'reloadUserConfig'],
}
const sandboxFields: Readonly<Record<string, readonly string[]>> = {
  dangerFullAccess: ['type'], readOnly: ['type', 'networkAccess'], externalSandbox: ['type', 'networkAccess'],
  workspaceWrite: ['type', 'writableRoots', 'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp'],
}

/** Checks explicit project-scope overrides. This is not a filesystem sandbox or
 * verification of existing sticky state / named native permission profiles. */
export function validateProjectControlScope(method: string, params: ObjectValue, cwd: string,
  refuse: (message: string) => Error): void {
  const fail = (location: string): never => { throw refuse(`Project scope refused at ${location}`) }
  const fields = (value: ObjectValue, allowed: readonly string[] | undefined, location: string): void => {
    if (!allowed || Object.keys(value).some(key => !allowed.includes(key))) fail(location)
  }
  const roots = (value: unknown, location: string, allowEmpty = false): void => {
    if (!Array.isArray(value) || (!allowEmpty && value.length !== 1) || value.some(root => root !== cwd)) fail(location)
  }
  const visit = (value: unknown, node: ScopeNode, location: string): void => {
    if (!object(value)) fail(location)
    const record = value as ObjectValue
    if (node === 'request') {
      if (mutationFields[method]) fields(record, mutationFields[method], location)
    } else if (node === 'environment') {
      fields(record, ['environmentId', 'cwd', 'runtimeWorkspaceRoots'], location)
      if (record.environmentId !== 'local' || record.cwd !== cwd) fail(location)
    } else {
      fields(record, sandboxFields[String(record.type)], location)
      if (record.type === 'workspaceWrite') roots(record.writableRoots, `${location}.writableRoots`, true)
      return
    }
    if (record.cwd != null && record.cwd !== cwd) fail(`${location}.cwd`)
    if (record.runtimeWorkspaceRoots != null) roots(record.runtimeWorkspaceRoots, `${location}.runtimeWorkspaceRoots`)
    if (node !== 'request') return
    if (record.cwds != null) roots(record.cwds, `${location}.cwds`, true)
    if (record.environments != null) {
      if (!Array.isArray(record.environments)) fail(`${location}.environments`)
      for (const [index, environment] of (record.environments as unknown[]).entries()) visit(environment, 'environment', `${location}.environments[${index}]`)
    }
    if (record.sandboxPolicy != null) visit(record.sandboxPolicy, 'sandbox', `${location}.sandboxPolicy`)
  }
  visit(params, 'request', method)
}
