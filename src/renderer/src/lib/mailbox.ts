import type { LabelWithCounts } from '@shared/types'
import { SYSTEM_LABELS } from '@shared/types'
import { useUnibox } from '../state'

export interface ThreadLabelTargets {
  /** The one account the selection belongs to, or `null` when it spans several. */
  accountId: string | null
  /** User labels of that account — the only ones worth offering. */
  available: LabelWithCounts[]
  /** Labels the opened conversation already carries on every message. */
  applied: Set<string>
  /** Local id of that account's `INBOX`, needed to move a mail out of it. */
  inboxLabelId: string | null
  /** The user label whose mailbox is open, if any — a move leaves it behind. */
  currentLabelId: string | null
}

/**
 * Labels are account-bound, so every label action first has to agree on one
 * account. A selection spanning accounts has no labels to offer at all.
 */
export function useThreadLabels(): ThreadLabelTargets {
  const { thread, threads, labels, selection, selectedThreadIds } = useUnibox()
  const chosen = new Set(selectedThreadIds)
  const accountIds = new Set(
    threads.filter((item) => chosen.has(item.threadId)).map((item) => item.accountId)
  )
  const accountId = accountIds.size === 1 ? [...accountIds][0]! : null
  if (!accountId) {
    return {
      accountId: null,
      available: [],
      applied: new Set(),
      inboxLabelId: null,
      currentLabelId: null
    }
  }

  const own = labels[accountId] ?? []
  const available = own.filter((label) => label.type === 'user')
  // Only a single opened conversation reveals which labels are already on it.
  const applied = new Set(
    selectedThreadIds.length === 1 && thread
      ? available
          .filter((label) =>
            thread.messages.every((message) => message.labelIds.includes(label.id))
          )
          .map((label) => label.id)
      : []
  )
  const inboxLabelId = own.find((label) => label.remoteId === SYSTEM_LABELS.inbox)?.id ?? null
  const currentLabelId = available.find((label) => label.id === selection.labelId)?.id ?? null

  return { accountId, available, applied, inboxLabelId, currentLabelId }
}

export interface LabelNode {
  /** The label itself, or `null` for a path segment nothing was ever named after. */
  label: LabelWithCounts | null
  /** The last path segment — what a row shows. */
  name: string
  /** The full path, unique per account and stable enough to key a row by. */
  path: string
  children: LabelNode[]
}

/**
 * Gmail has no nested labels, only slashes in their names: `Kunden/Offerten` is
 * one label, not two. This turns that convention back into the tree the user
 * had in mind — including the branch they never created, which shows up as a
 * node with no label of its own. `Label.parentId` cannot stand in for this: it
 * is null exactly when that intermediate label is missing.
 */
export function buildLabelTree(labels: LabelWithCounts[]): LabelNode[] {
  const roots: LabelNode[] = []
  const byPath = new Map<string, LabelNode>()

  const nodeAt = (segments: string[]): LabelNode => {
    const path = segments.join('/')
    const existing = byPath.get(path)
    if (existing) return existing
    const node: LabelNode = { label: null, name: segments[segments.length - 1]!, path, children: [] }
    byPath.set(path, node)
    if (segments.length === 1) roots.push(node)
    else nodeAt(segments.slice(0, -1)).children.push(node)
    return node
  }

  for (const label of labels) {
    const segments = label.name.split('/').filter(Boolean)
    if (segments.length === 0) continue
    nodeAt(segments).label = label
  }

  const sort = (nodes: LabelNode[]): LabelNode[] => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'de'))
    nodes.forEach((node) => sort(node.children))
    return nodes
  }
  return sort(roots)
}

export interface LabelRow {
  label: LabelWithCounts
  /** The last path segment — the full path only ever belongs in a rename box. */
  name: string
  /** How far to indent, counting only ancestors that are labels themselves. */
  depth: number
}

/**
 * The tree back as a list, in the order it reads on screen. Sorting the full
 * paths instead would let `Kunden-AG` land between `Kunden` and `Kunden/Zebra`,
 * because collation looks past the slash — and the indentation would then point
 * at the wrong parent.
 */
export function flattenLabelTree(nodes: LabelNode[], depth = 1): LabelRow[] {
  return nodes.flatMap((node) => {
    // A branch nobody named carries no row, so its children move up one level.
    const own = node.label ? [{ label: node.label, name: node.name, depth }] : []
    return [...own, ...flattenLabelTree(node.children, depth + own.length)]
  })
}

/**
 * The mailboxes whose actions run the other way round: trash and spam offer a
 * way back instead of a way out, and the snooze view offers to end the snooze.
 */
export function useMailboxKind(): { inTrash: boolean; inSpam: boolean; inSnoozed: boolean } {
  const { labels, selection } = useUnibox()
  const current = selection.labelId
    ? Object.values(labels)
        .flat()
        .find((label) => label.id === selection.labelId)
    : null
  return {
    inTrash: current?.remoteId === SYSTEM_LABELS.trash,
    inSpam: current?.remoteId === SYSTEM_LABELS.spam,
    inSnoozed: selection.view === 'snoozed'
  }
}
