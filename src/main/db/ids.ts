import { randomUUID } from 'node:crypto'

export const newId = (): string => randomUUID()

export const messageKey = (accountId: string, remoteId: string): string =>
  `${accountId}:${remoteId}`

export const threadKey = (accountId: string, remoteId: string): string =>
  `${accountId}:t:${remoteId}`

export const labelKey = (accountId: string, remoteId: string): string =>
  `${accountId}:l:${remoteId}`

export const attachmentKey = (messageId: string, partId: string): string =>
  `${messageId}:a:${partId}`
