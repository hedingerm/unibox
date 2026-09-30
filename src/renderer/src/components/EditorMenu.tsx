import type { Editor } from '@tiptap/react'
import type { AiSpot } from '@shared/types'
import { t } from '../i18n'
import { api } from '../lib/bridge'
import { useOpenLink } from '../lib/links'
import { buildSpot } from '../lib/spot'
import { ContextMenu, MenuDivider, MenuInput, MenuItem, Submenu } from './ContextMenu'
import {
  BoldIcon,
  BulletListIcon,
  ClearFormatIcon,
  CodeIcon,
  CopyIcon,
  CutIcon,
  ItalicIcon,
  LinkIcon,
  OpenLinkIcon,
  OrderedListIcon,
  PasteIcon,
  QuoteIcon,
  StrikeIcon,
  TableIcon,
  UnderlineIcon,
  UnlinkIcon
} from './EditorIcons'

interface EditorMenuProps {
  editor: Editor
  x: number
  y: number
  /** Asks for a link address; the composer owns the dialog it opens in. */
  askLink: (initial: string) => Promise<string | null>
  /**
   * Hands over an assistant job for the marked place. Null while one is
   * already running — a second would race the first into the same range.
   */
  onAi: ((instruction: string, spot: AiSpot) => void) | null
  onClose: () => void
}

/**
 * The composer's right-click menu. Everything here already exists as a
 * shortcut or a toolbar button — what the menu adds is that it acts on the
 * place the pointer is, which is what makes asking the assistant for one
 * sentence rather than the whole mail possible at all.
 */
export function EditorMenu({
  editor,
  x,
  y,
  askLink,
  onAi,
  onClose
}: EditorMenuProps): React.JSX.Element {
  const openLink = useOpenLink()
  const chain = (): ReturnType<Editor['chain']> => editor.chain().focus()
  const run = (action: (c: ReturnType<Editor['chain']>) => void): void => {
    const c = chain()
    action(c)
    onClose()
  }

  const { from, to, empty } = editor.state.selection
  const selection = editor.state.doc.textBetween(from, to, '\n\n', ' ')
  const onLink = editor.isActive('link')
  const href = (editor.getAttributes('link').href as string | undefined) ?? ''

  const copy = async (text: string): Promise<void> => {
    if (text) await api.invoke('clipboard:write', text)
    onClose()
  }

  const editLink = async (): Promise<void> => {
    // Closing first: the dialog takes the focus, and a menu still hanging over
    // the draft would sit on top of the field the user is typing into.
    onClose()
    const url = await askLink(href || 'https://')
    if (url === null) return
    if (url === '') chain().unsetLink().run()
    else chain().setLink({ href: url }).run()
  }

  return (
    <ContextMenu x={x} y={y} label={t('compose.menu.title')} onClose={onClose}>
      {onAi ? (
        <>
          <MenuInput
            label={empty ? t('compose.menu.aiInsert') : t('compose.menu.aiChange')}
            placeholder={t('compose.menu.aiPlaceholder')}
            onSubmit={(instruction) => {
              // The spot is read before the menu goes away, while the selection
              // is still the one the user opened the menu on.
              const spot = buildSpot(editor)
              onClose()
              onAi(instruction, spot)
            }}
          />
          <MenuDivider />
        </>
      ) : null}

      <MenuItem
        label={t('compose.menu.cut')}
        icon={<CutIcon />}
        disabled={empty}
        onClick={() => {
          void copy(selection)
          chain().deleteSelection().run()
        }}
      />
      <MenuItem
        label={t('compose.menu.copy')}
        icon={<CopyIcon />}
        disabled={empty}
        onClick={() => void copy(selection)}
      />
      <MenuItem
        label={t('compose.menu.paste')}
        icon={<PasteIcon />}
        onClick={() => {
          void (async () => {
            const text = await api.invoke('clipboard:read')
            onClose()
            // Plain text, always: a paste that carried markup would smuggle a
          // sender's styling into the draft, and the toolbar is how formatting
          // gets in here.
          if (text) chain().insertContent(text).run()
          })()
        }}
      />
      <MenuDivider />

      {onLink ? (
        <>
          <MenuItem
            label={t('compose.menu.openLink')}
            icon={<OpenLinkIcon />}
            disabled={!href}
            onClick={() => {
              onClose()
              openLink(href)
            }}
          />
          <MenuItem
            label={t('compose.menu.editLink')}
            icon={<LinkIcon />}
            onClick={() => void editLink()}
          />
          <MenuItem
            label={t('compose.menu.copyLink')}
            icon={<CopyIcon />}
            disabled={!href}
            onClick={() => void copy(href)}
          />
          <MenuItem
            label={t('compose.menu.removeLink')}
            icon={<UnlinkIcon />}
            onClick={() => run((c) => c.unsetLink().run())}
          />
        </>
      ) : (
        <MenuItem
          label={t('compose.menu.addLink')}
          icon={<LinkIcon />}
          onClick={() => void editLink()}
        />
      )}
      <MenuDivider />

      <MenuItem
        label={t('compose.toolbar.bold')}
        icon={<BoldIcon />}
        checked={editor.isActive('bold')}
        onClick={() => run((c) => c.toggleBold().run())}
      />
      <MenuItem
        label={t('compose.toolbar.italic')}
        icon={<ItalicIcon />}
        checked={editor.isActive('italic')}
        onClick={() => run((c) => c.toggleItalic().run())}
      />
      <MenuItem
        label={t('compose.toolbar.underline')}
        icon={<UnderlineIcon />}
        checked={editor.isActive('underline')}
        onClick={() => run((c) => c.toggleUnderline().run())}
      />
      <MenuItem
        label={t('compose.toolbar.strike')}
        icon={<StrikeIcon />}
        checked={editor.isActive('strike')}
        onClick={() => run((c) => c.toggleStrike().run())}
      />
      <Submenu label={t('compose.menu.more')}>
        <MenuItem
          label={t('compose.toolbar.bulletList')}
          icon={<BulletListIcon />}
          checked={editor.isActive('bulletList')}
          onClick={() => run((c) => c.toggleBulletList().run())}
        />
        <MenuItem
          label={t('compose.toolbar.orderedList')}
          icon={<OrderedListIcon />}
          checked={editor.isActive('orderedList')}
          onClick={() => run((c) => c.toggleOrderedList().run())}
        />
        <MenuItem
          label={t('compose.toolbar.quote')}
          icon={<QuoteIcon />}
          checked={editor.isActive('blockquote')}
          onClick={() => run((c) => c.toggleBlockquote().run())}
        />
        <MenuItem
          label={t('compose.toolbar.code')}
          icon={<CodeIcon />}
          checked={editor.isActive('code')}
          onClick={() => run((c) => c.toggleCode().run())}
        />
        <MenuItem
          label={t('compose.toolbar.table')}
          icon={<TableIcon />}
          onClick={() => run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
        />
        <MenuDivider />
        <MenuItem
          label={t('compose.toolbar.clear')}
          icon={<ClearFormatIcon />}
          onClick={() => run((c) => c.unsetAllMarks().clearNodes().run())}
        />
      </Submenu>
    </ContextMenu>
  )
}
