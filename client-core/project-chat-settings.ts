import { GatewayHttpClient } from './index.ts'

export type ProjectChatProvider = 'anthropic' | 'openai-codex' | 'openai' | 'pi'
export interface ProjectChatSettings {
  project: { model_provider: ProjectChatProvider | null }
  model_provider_resolution: { provider: ProjectChatProvider; source: 'project' | 'instance' | 'application' }
}
export interface ProjectCodexStatus {
  owner_credential?: { configured: boolean | null; checked_at: string; detail: string }
}
export const CHAT_PROVIDER_CHOICES = [
  { value: 'inherit', label: 'Follow instance' },
  { value: 'anthropic', label: 'Claude Code' },
  { value: 'openai-codex', label: 'Codex' },
] as const
export function chatProviderName(provider: string): string {
  return CHAT_PROVIDER_CHOICES.find(choice => choice.value === provider)?.label ?? provider
}

/** Shared web/phone wire path. A provider selection never connects a credential. */
export class ProjectChatSettingsClient extends GatewayHttpClient {
  protected override readonly guardNetworkErrors = true

  private path(projectId: string, surface: string): string {
    if (!projectId) throw new Error('Project chat settings require a project')
    return `/api/app/projects/${encodeURIComponent(projectId)}/${surface}`
  }

  private settings(raw: ProjectChatSettings): ProjectChatSettings {
    const known = ['anthropic', 'openai-codex', 'openai', 'pi']
    if (!raw?.project || !(raw.project.model_provider === null || known.includes(raw.project.model_provider))
      || !known.includes(raw.model_provider_resolution?.provider)
      || !['project', 'instance', 'application'].includes(raw.model_provider_resolution?.source)) {
      throw new Error('The server did not return project provider settings')
    }
    return raw
  }

  async get(projectId: string): Promise<ProjectChatSettings> {
    return this.settings(await this.req(this.path(projectId, 'settings')))
  }

  async set(projectId: string, provider: 'anthropic' | 'openai-codex' | null): Promise<ProjectChatSettings> {
    return this.settings(await this.req(this.path(projectId, 'settings'), { method: 'PATCH', body: { model_provider: provider } }))
  }

  credential(projectId: string): Promise<ProjectCodexStatus> {
    return this.req(this.path(projectId, 'codex-auth'))
  }

  async connectCredential(projectId: string, auth: string): Promise<ProjectCodexStatus> {
    await this.req(this.path(projectId, 'codex-auth'), { method: 'POST', body: { auth } })
    return this.credential(projectId)
  }
}
