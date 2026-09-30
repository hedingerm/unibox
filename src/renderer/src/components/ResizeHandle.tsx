import { useRef } from 'react'
import { clamp } from '../lib/layout'

interface ResizeHandleProps {
  /** Current width of the pane the handle sits on the right edge of. */
  value: number
  min: number
  max: number
  label: string
  onChange: (value: number) => void
}

/** Pixels an arrow key moves the edge — coarse enough to be worth a press. */
const KEY_STEP = 16

/**
 * The draggable right edge of a pane. Pointer capture keeps the drag alive
 * when the pointer outruns the 6px strip; the arrow keys make it reachable
 * without a mouse, which is what the separator role promises.
 */
export function ResizeHandle({
  value,
  min,
  max,
  label,
  onChange
}: ResizeHandleProps): React.JSX.Element {
  const drag = useRef<{ x: number; start: number } | null>(null)

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)
        drag.current = { x: event.clientX, start: value }
        document.body.classList.add('is-resizing')
      }}
      onPointerMove={(event) => {
        const origin = drag.current
        if (!origin) return
        onChange(clamp(origin.start + event.clientX - origin.x, min, max))
      }}
      onPointerUp={(event) => {
        drag.current = null
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        document.body.classList.remove('is-resizing')
      }}
      onPointerCancel={() => {
        drag.current = null
        document.body.classList.remove('is-resizing')
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          // Stop here: j/k-style shortcuts must not see the arrow as well.
          event.stopPropagation()
          onChange(clamp(value + (event.key === 'ArrowLeft' ? -KEY_STEP : KEY_STEP), min, max))
        }
      }}
    />
  )
}
