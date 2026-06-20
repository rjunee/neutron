/**
 * @neutronai/channels — Telegram forum-topics primitive.
 *
 * Bot API 9.6 newly enables `createForumTopic` in private chats
 * (matches master-plan §1.10's project-as-topic model). This module
 * wraps the createForumTopic / editForumTopic / closeForumTopic /
 * reopenForumTopic / deleteForumTopic methods.
 */

import type { TelegramClient } from './client.ts'

export interface CreateForumTopicInput {
  chat_id: number | string
  name: string
  /** Optional integer color RGB. Telegram supports a fixed palette. */
  icon_color?: number
  icon_custom_emoji_id?: string
}

export interface ForumTopicResult {
  message_thread_id: number
  name: string
  icon_color?: number
  icon_custom_emoji_id?: string
}

export async function createForumTopic(
  client: TelegramClient,
  input: CreateForumTopicInput,
): Promise<ForumTopicResult> {
  return client.call<CreateForumTopicInput, ForumTopicResult>('createForumTopic', input)
}

export interface EditForumTopicInput {
  chat_id: number | string
  message_thread_id: number
  name?: string
  icon_custom_emoji_id?: string
}

export async function editForumTopic(client: TelegramClient, input: EditForumTopicInput): Promise<true> {
  return client.call<EditForumTopicInput, true>('editForumTopic', input)
}

export interface CloseOrReopenForumTopicInput {
  chat_id: number | string
  message_thread_id: number
}

export async function closeForumTopic(
  client: TelegramClient,
  input: CloseOrReopenForumTopicInput,
): Promise<true> {
  return client.call<CloseOrReopenForumTopicInput, true>('closeForumTopic', input)
}

export async function reopenForumTopic(
  client: TelegramClient,
  input: CloseOrReopenForumTopicInput,
): Promise<true> {
  return client.call<CloseOrReopenForumTopicInput, true>('reopenForumTopic', input)
}

export async function deleteForumTopic(
  client: TelegramClient,
  input: CloseOrReopenForumTopicInput,
): Promise<true> {
  return client.call<CloseOrReopenForumTopicInput, true>('deleteForumTopic', input)
}
