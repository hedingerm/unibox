import '@testing-library/jest-dom/vitest'

// Renderer tests opt into the DOM with `// @vitest-environment jsdom`.
// jsdom implements no layout, so scrolling APIs need a stub.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {
    /* no layout in jsdom */
  }
}

// ProseMirror measures the caret before it scrolls to it. jsdom has no layout,
// so text nodes carry no rect API at all — without these the editor throws on
// every transaction.
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
}
if (typeof Text !== 'undefined' && !('getClientRects' in Text.prototype)) {
  Object.defineProperty(Text.prototype, 'getClientRects', {
    value: () => [] as unknown as DOMRectList,
    configurable: true
  })
}
