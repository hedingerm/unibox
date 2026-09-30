import { describe, expect, it } from 'vitest'
import type { LabelWithCounts } from '@shared/types'
import { buildLabelTree, flattenLabelTree } from '@renderer/lib/mailbox'

function label(name: string): LabelWithCounts {
  return {
    id: `a:l:${name}`,
    accountId: 'a',
    remoteId: name,
    name,
    parentId: null,
    type: 'user',
    color: null,
    total: 0,
    unread: 0
  }
}

describe('buildLabelTree', () => {
  it('nests a slash path and keeps the leaf name on the row', () => {
    const tree = buildLabelTree([label('Kunden/Offerten'), label('Kunden')])

    expect(tree).toHaveLength(1)
    expect(tree[0]!.name).toBe('Kunden')
    expect(tree[0]!.label?.name).toBe('Kunden')
    expect(tree[0]!.children.map((node) => node.name)).toEqual(['Offerten'])
  })

  it('creates the missing branch of a sublabel whose parent was never made', () => {
    const tree = buildLabelTree([label('Projekte/2026/Q1')])

    expect(tree[0]!.name).toBe('Projekte')
    // Nothing to click on: Gmail only ever stored the full path as one label.
    expect(tree[0]!.label).toBeNull()
    expect(tree[0]!.children[0]!.label).toBeNull()
    expect(tree[0]!.children[0]!.children[0]!.label?.name).toBe('Projekte/2026/Q1')
  })

  it('sorts siblings by their own segment, not the full path', () => {
    const tree = buildLabelTree([label('Kunden/Zebra'), label('Kunden/Alpha'), label('Kunden')])

    expect(tree[0]!.children.map((node) => node.name)).toEqual(['Alpha', 'Zebra'])
  })
})

describe('flattenLabelTree', () => {
  it('keeps a label and its children together, whatever sorts between them', () => {
    // Collation looks past the slash, so a flat sort would put Kunden-AG in the
    // middle of the Kunden branch and indent Zebra under the wrong parent.
    const rows = flattenLabelTree(
      buildLabelTree([label('Kunden'), label('Kunden/Zebra'), label('Kunden-AG')])
    )

    expect(rows.map((row) => [row.name, row.depth])).toEqual([
      ['Kunden', 1],
      ['Zebra', 2],
      ['Kunden-AG', 1]
    ])
  })

  it('does not indent past a branch that carries no row of its own', () => {
    const rows = flattenLabelTree(buildLabelTree([label('Projekte/Q1')]))

    expect(rows.map((row) => [row.name, row.depth])).toEqual([['Q1', 1]])
  })
})
