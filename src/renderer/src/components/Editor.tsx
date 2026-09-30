import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import { Extension, Node, type Extensions } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import StarterKit from '@tiptap/starter-kit'
import { TextStyleKit } from '@tiptap/extension-text-style'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { useEffect, useRef, type ReactNode } from 'react'
import { t } from '../i18n'
import { QUOTE_MARKER, SIGNATURE_MARKER } from '../lib/compose'
import { hasFiles } from '../lib/attachments'
import {
  BoldIcon,
  BulletListIcon,
  ClearFormatIcon,
  CodeIcon,
  ImageIcon,
  ItalicIcon,
  LinkIcon,
  OrderedListIcon,
  QuoteIcon,
  StrikeIcon,
  TableIcon,
  UnderlineIcon
} from './EditorIcons'
import { usePrompt } from './PromptDialog'

/** The block as it goes into the document and back out: its own html, verbatim. */
function rawBlockElement(marker: string, html: string): HTMLElement {
  const dom = document.createElement('div')
  dom.setAttribute(marker, 'true')
  dom.innerHTML = html
  return dom
}

/**
 * Signature and forwarded original ride along in the draft as opaque blocks:
 * the html goes onto the node untouched and comes back out unchanged. Parsing
 * them into the editor schema instead cost every attribute the schema does not
 * know — inline styles, cell widths, image sizes — so a table-based signature
 * or a quoted mail turned into a bare grid, both in the editor and, because the
 * draft is serialised out of it, in what the recipient got.
 *
 * A plain `div` is in no default schema either: without a node for it the
 * editor flattens both into paragraphs and the marker is gone, so the signature
 * stacks up on an identity change and the quote counts as the user's own draft.
 */
function markedBlock(name: string, marker: string): Node {
  return Node.create({
    name,
    group: 'block',
    atom: true,
    defining: true,
    isolating: true,
    addAttributes: () => ({
      html: {
        default: '',
        parseHTML: (element: HTMLElement) => element.innerHTML,
        // The html is the node's content, not one of its attributes.
        renderHTML: () => ({})
      }
    }),
    parseHTML: () => [{ tag: `div[${marker}]` }],
    renderHTML: ({ node }) => rawBlockElement(marker, String(node.attrs.html ?? '')),
    addNodeView:
      () =>
      ({ node }) => {
        const dom = rawBlockElement(marker, String(node.attrs.html ?? ''))
        // Marks the block for the stylesheet, which must keep the editor's own
        // table and image rules out of mail html it is only showing.
        dom.classList.add('raw-block')
        dom.contentEditable = 'false'
        // Images finishing their load inside the block are not edits.
        return { dom, ignoreMutation: () => true }
      }
  })
}

/**
 * Mail is table html, and its layout sits in inline styles and width attributes
 * on the table, its cells and its images. The default schema knows none of them
 * and drops them on the way in, so anything pasted or quoted came back out as
 * an undecorated grid. Carrying them as passthrough attributes leaves the
 * markup as the sender wrote it.
 */
const LAYOUT_ATTRIBUTES = ['style', 'width', 'height', 'align', 'valign', 'bgcolor']

const preserveLayout = Extension.create({
  name: 'preserveLayout',
  addGlobalAttributes: () => [
    {
      types: ['table', 'tableRow', 'tableCell', 'tableHeader', 'image'],
      attributes: Object.fromEntries(
        LAYOUT_ATTRIBUTES.map((name) => [
          name,
          {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute(name),
            renderHTML: (attributes: Record<string, string | null>) =>
              attributes[name] ? { [name]: attributes[name] } : {}
          }
        ])
      )
    }
  ]
})


/**
 * The draft's schema, in one place: a plain-text `Cmd+Click` on a link opens
 * it, so the click itself must stay with the editor — `openOnClick` would
 * follow every click and make placing the caret inside a link impossible.
 */
const HOLD_SELECTION = new PluginKey('holdSelection')

/**
 * Paints the selection while something else holds the focus. A browser stops
 * painting the selection of a `contenteditable` the moment it is blurred — so
 * right-clicking a marked sentence, which moves the focus into the menu, made
 * exactly the text the menu is about invisible. The toolbar had it too.
 *
 * Focus is not part of the editor state, so a blur alone recomputes nothing;
 * the empty transaction is what asks for the decoration to be looked at again.
 * It carries no document change, so no autosave reads it as an edit.
 */
const holdSelection = Extension.create({
  name: 'holdSelection',
  addProseMirrorPlugins() {
    const { editor } = this
    return [
      new Plugin({
        key: HOLD_SELECTION,
        props: {
          decorations: (state) => {
            const { from, to, empty } = state.selection
            if (empty || editor.isFocused) return null
            return DecorationSet.create(state.doc, [
              Decoration.inline(from, to, { class: 'selection-held' })
            ])
          },
          handleDOMEvents: {
            blur: (view) => {
              view.dispatch(view.state.tr.setMeta(HOLD_SELECTION, true))
              return false
            },
            focus: (view) => {
              view.dispatch(view.state.tr.setMeta(HOLD_SELECTION, true))
              return false
            }
          }
        }
      })
    ]
  }
})

export function editorExtensions(): Extensions {
  return [
    StarterKit.configure({
      link: { openOnClick: false },
      // Every Enter is a new paragraph. With the default `1em` margins in the
      // editor, and whatever the recipient's client adds, a blank line came out
      // two lines high — inline, so the mail looks the way it was written.
      paragraph: { HTMLAttributes: { style: 'margin:0' } }
    }),
    holdSelection,
    markedBlock('signature', SIGNATURE_MARKER),
    markedBlock('quote', QUOTE_MARKER),
    TextStyleKit,
    preserveLayout,
    TableKit.configure({ table: { resizable: false } }),
    Image.configure({ inline: false, allowBase64: true })
  ]
}

export interface RichTextEditorHandle {
  editor: Editor | null
}

interface EditorToolbarProps {
  editor: Editor | null
  onInsertImage: () => void
}

function ToolbarButton({
  editor,
  label,
  icon,
  active,
  onClick
}: {
  editor: Editor | null
  label: string
  icon: ReactNode
  active?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active ?? false}
      className={active ? 'is-active' : undefined}
      disabled={!editor}
      // The toolbar is not a stop on the way to the draft: Tab goes from the
      // address fields straight into the text, the buttons stay on the mouse.
      tabIndex={-1}
      onClick={onClick}
    >
      {icon}
    </button>
  )
}

export function EditorToolbar({ editor, onInsertImage }: EditorToolbarProps): React.JSX.Element {
  const chain = (): ReturnType<Editor['chain']> | null => editor?.chain().focus() ?? null
  const { ask, dialog } = usePrompt()

  return (
    <div className="editor-toolbar" role="toolbar" aria-label={t('compose.title')}>
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.bold')}
        icon={<BoldIcon />}
        active={editor?.isActive('bold')}
        onClick={() => chain()?.toggleBold().run()}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.italic')}
        icon={<ItalicIcon />}
        active={editor?.isActive('italic')}
        onClick={() => chain()?.toggleItalic().run()}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.underline')}
        icon={<UnderlineIcon />}
        active={editor?.isActive('underline')}
        onClick={() => chain()?.toggleUnderline().run()}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.strike')}
        icon={<StrikeIcon />}
        active={editor?.isActive('strike')}
        onClick={() => chain()?.toggleStrike().run()}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.bulletList')}
        icon={<BulletListIcon />}
        active={editor?.isActive('bulletList')}
        onClick={() => chain()?.toggleBulletList().run()}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.orderedList')}
        icon={<OrderedListIcon />}
        active={editor?.isActive('orderedList')}
        onClick={() => chain()?.toggleOrderedList().run()}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.quote')}
        icon={<QuoteIcon />}
        active={editor?.isActive('blockquote')}
        onClick={() => chain()?.toggleBlockquote().run()}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.code')}
        icon={<CodeIcon />}
        active={editor?.isActive('code')}
        onClick={() => chain()?.toggleCode().run()}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.link')}
        icon={<LinkIcon />}
        active={editor?.isActive('link')}
        onClick={async () => {
          const url = await ask({
            label: t('compose.toolbar.linkPrompt'),
            initial: (editor?.getAttributes('link').href as string | undefined) ?? 'https://'
          })
          if (url === null) return
          // An emptied field means the link goes away — only a cancel is a no-op.
          if (url === '') chain()?.unsetLink().run()
          else chain()?.setLink({ href: url }).run()
        }}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.table')}
        icon={<TableIcon />}
        onClick={() => chain()?.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.image')}
        icon={<ImageIcon />}
        onClick={onInsertImage}
      />
      <input
        type="color"
        aria-label={t('compose.toolbar.color')}
        title={t('compose.toolbar.color')}
        tabIndex={-1}
        onChange={(event) => chain()?.setColor(event.target.value).run()}
      />
      <ToolbarButton
        editor={editor}
        label={t('compose.toolbar.clear')}
        icon={<ClearFormatIcon />}
        onClick={() => chain()?.unsetAllMarks().clearNodes().run()}
      />
      {dialog}
    </div>
  )
}

export function useRichTextEditor(
  initialHtml: string,
  onUpdate: (html: string, editor: Editor) => void,
  /**
   * Asked on Enter with the text of the block the cursor sits in. Returning an
   * action marks that block as a command rather than mail text: the editor
   * clears it first — so the action already sees a clean draft — then runs the
   * action and swallows the Enter.
   */
  onEnterCommand?: (line: string) => (() => void) | null,
  /**
   * Puts the caret in the draft as soon as the editor exists. tiptap does this
   * while it builds the instance — focusing from an effect would reach for an
   * editor that StrictMode has just torn down and left without a view.
   */
  autofocus = false,
  /**
   * Follows a link the user Cmd+Clicked. Without the modifier the click stays
   * with the editor: a plain click that opened the browser would make putting
   * the caret inside a link impossible, and the draft is there to be edited.
   */
  onOpenLink?: (href: string) => void
): Editor | null {
  // The editor is built once, the callback is new every render; a ref keeps the
  // handler on the current one instead of the first.
  const command = useRef(onEnterCommand)
  const openLink = useRef(onOpenLink)
  useEffect(() => {
    command.current = onEnterCommand
    openLink.current = onOpenLink
  })

  const editor = useEditor({
    extensions: editorExtensions(),
    content: initialHtml,
    autofocus: autofocus ? 'start' : false,
    editorProps: {
      // A file dragged in from the Finder is the composer's business, not the
      // editor's: without this, ProseMirror would insert the drag's text
      // payload — for a Finder drop, the file's own path — as mail text.
      // Claiming the drop only stops that; the composer's handler still sees
      // the event on its way up and reads the files.
      handleDrop: (_view, event) => hasFiles((event as DragEvent).dataTransfer),
      handleClick: (view, pos, event) => {
        const mouse = event as MouseEvent
        if ((!mouse.metaKey && !mouse.ctrlKey) || !openLink.current) return false
        const at = view.state.doc.resolve(pos)
        // Marks before the position and on the character after it: a click on
        // the very first letter of a link belongs to the link too.
        const marks = [...at.marks(), ...(at.nodeAfter?.marks ?? [])]
        const href = marks.find((mark) => mark.type.name === 'link')?.attrs.href
        if (typeof href !== 'string' || href === '') return false
        openLink.current(href)
        return true
      },
      handleKeyDown: (view, event) => {
        // Shift+Enter is a line break inside the paragraph, never a command.
        if (event.key !== 'Enter' || event.shiftKey || !command.current) return false
        const { $from, empty } = view.state.selection
        if (!empty || !$from.parent.isTextblock) return false
        const action = command.current($from.parent.textContent)
        if (!action) return false
        event.preventDefault()
        view.dispatch(view.state.tr.delete($from.start(), $from.end()))
        action()
        return true
      }
    },
    // Merely putting the caret in the draft reports an update, and tiptap
    // hands back its own serialization of the content — a wrapped `<br>`, a
    // trailing paragraph. Passing that on would make an untouched window look
    // edited, which is what left an empty draft behind for every signature.
    onUpdate: ({ editor: instance, transaction }) => {
      if (!transaction.docChanged) return
      onUpdate(instance.getHTML(), instance)
    }
  })

  useEffect(() => {
    return () => {
      editor?.destroy()
    }
    // The editor instance is stable for the lifetime of the compose window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return editor
}

/**
 * `hidden` keeps the editor mounted while something else takes its place —
 * unmounting it would throw away the draft's undo history.
 */
export function EditorSurface({
  editor,
  hidden,
  onContextMenu,
  onKeyDown
}: {
  editor: Editor | null
  hidden?: boolean
  onContextMenu?: (event: React.MouseEvent) => void
  onKeyDown?: (event: React.KeyboardEvent) => void
}): React.JSX.Element {
  return (
    <div
      className="compose__editor"
      hidden={hidden}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    >
      <EditorContent editor={editor} />
    </div>
  )
}
