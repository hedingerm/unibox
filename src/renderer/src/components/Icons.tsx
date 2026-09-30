interface IconProps {
  size?: number
  color?: string
}

function base(size: number, color: string): Record<string, string | number> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: color,
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  }
}

export function InboxIcon({ size = 15, color = 'var(--text-faint)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M3.5 3h9L14 9.5V13H2V9.5z" />
      <path d="M2 9.5h3.2l1.1 1.8h3.4l1.1-1.8H14" />
    </svg>
  )
}

export function SendIcon({ size = 15, color = 'var(--text-faint)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M14 2L7 9" />
      <path d="M14 2L9.5 14l-2.5-5-5-2.5z" />
    </svg>
  )
}

export function DraftIcon({ size = 15, color = 'var(--text-faint)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M11.5 2.5l2 2L5 13l-2.7.7L3 11z" />
    </svg>
  )
}

export function LabelIcon({ size = 13, color = 'var(--text-faint)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M2 2h5l7 7-5 5-7-7z" />
      <circle cx="5" cy="5" r="1" />
    </svg>
  )
}

export function ArchiveIcon({ size = 16, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <rect x="2" y="3" width="12" height="3" rx="1" />
      <path d="M3 6v6.5A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V6" />
      <path d="M6.5 9h3" />
    </svg>
  )
}

export function TrashIcon({ size = 16, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M3 4h10" />
      <path d="M6.5 4V2.5h3V4" />
      <path d="M4.5 4l.5 9.5h6l.5-9.5" />
    </svg>
  )
}

export function ReplyIcon({ size = 16, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M6 3L2 7l4 4" />
      <path d="M2 7h7a5 5 0 015 5v1" />
    </svg>
  )
}

export function ForwardIcon({ size = 16, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M10 3l4 4-4 4" />
      <path d="M14 7H7a5 5 0 00-5 5v1" />
    </svg>
  )
}

export function SearchIcon({ size = 14, color = 'var(--text-faint)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  )
}

export function SettingsIcon({ size = 15, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M6.44 3.72L6.79 1.77A6.35 6.35 0 0 1 9.21 1.77L9.56 3.72A4.55 4.55 0 0 1 9.92 3.88L11.55 2.74A6.35 6.35 0 0 1 13.26 4.45L12.12 6.08A4.55 4.55 0 0 1 12.28 6.44L14.23 6.79A6.35 6.35 0 0 1 14.23 9.21L12.28 9.56A4.55 4.55 0 0 1 12.12 9.92L13.26 11.55A6.35 6.35 0 0 1 11.55 13.26L9.92 12.12A4.55 4.55 0 0 1 9.56 12.28L9.21 14.23A6.35 6.35 0 0 1 6.79 14.23L6.44 12.28A4.55 4.55 0 0 1 6.08 12.12L4.45 13.26A6.35 6.35 0 0 1 2.74 11.55L3.88 9.92A4.55 4.55 0 0 1 3.72 9.56L1.77 9.21A6.35 6.35 0 0 1 1.77 6.79L3.72 6.44A4.55 4.55 0 0 1 3.88 6.08L2.74 4.45A6.35 6.35 0 0 1 4.45 2.74L6.08 3.88Z" />
      <circle cx="8" cy="8" r="2.3" />
    </svg>
  )
}

export function SpamIcon({ size = 16, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M8 2l6 3v4c0 3-2.6 5-6 5S2 12 2 9V5z" />
      <path d="M8 5.5v3.5" />
      <path d="M8 11h.01" />
    </svg>
  )
}

export function RefreshIcon({ size = 16, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M13.5 8a5.5 5.5 0 10-1.6 3.9" />
      <path d="M13.5 4.5V8H10" />
    </svg>
  )
}

export function SettleIcon({ size = 16, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M2.5 12.5l7-7" />
      <path d="M8.5 3.5l4 4" />
      <path d="M11.5 1.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z" />
      <path d="M4 8.5l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z" />
    </svg>
  )
}

export function CloseIcon({ size = 12, color = 'currentColor' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}

export function ExpandIcon({ size = 13, color = 'var(--text-faint)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M9.5 2.5H13.5V6.5" />
      <path d="M13.5 2.5L8.5 7.5" />
      <path d="M12 9.5v3a1 1 0 01-1 1H3.5a1 1 0 01-1-1V5a1 1 0 011-1h3" />
    </svg>
  )
}

export function AttachIcon({ size = 15, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M11 5L5.8 10.2a1.8 1.8 0 002.5 2.5l5.2-5.2a3.2 3.2 0 00-4.5-4.5L3.4 8.6a4.6 4.6 0 006.5 6.5" />
    </svg>
  )
}

export function ClockIcon({ size = 15, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.5V8l2.5 1.5" />
    </svg>
  )
}

/**
 * Waiting for an answer. An hourglass rather than a second clock face: the
 * snooze row already owns the clock, and these two sit next to each other.
 */
export function HourglassIcon({ size = 15, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M4.5 2.5h7M4.5 13.5h7" />
      <path d="M5.5 2.5v2.2L8 7.4l2.5-2.7V2.5" />
      <path d="M5.5 13.5v-2.2L8 8.6l2.5 2.7v2.2" />
    </svg>
  )
}

export function CheckIcon({ size = 12, color = 'var(--accent-contrast)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M3.5 8.5l3 3 6-7" />
    </svg>
  )
}

export function ChevronIcon({
  size = 12,
  color = 'var(--text-faint)',
  open = true
}: IconProps & { open?: boolean }): React.JSX.Element {
  return (
    <svg
      {...base(size, color)}
      aria-hidden="true"
      style={{
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform var(--dur-fast) var(--ease-out)'
      }}
    >
      <path d="M6 3.5l5 4.5-5 4.5" />
    </svg>
  )
}

export function SparkleIcon({ size = 15, color = 'var(--text-faint)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M6 1.5l1.2 3.3L10.5 6 7.2 7.2 6 10.5 4.8 7.2 1.5 6l3.3-1.2z" />
      <path d="M12 9l.6 1.6 1.6.6-1.6.6L12 13.4l-.6-1.6-1.6-.6 1.6-.6z" />
    </svg>
  )
}

export function ProofreadIcon({ size = 15, color = 'var(--text-faint)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M2 4.5h8" />
      <path d="M2 8h5.5" />
      <path d="M2 11.5h3.5" />
      <path d="M9 11l1.8 1.8L14.5 9" />
    </svg>
  )
}

export function MenuIcon({ size = 18, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  )
}

export function MoreIcon({ size = 16, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <circle cx="8" cy="3.5" r="0.6" />
      <circle cx="8" cy="8" r="0.6" />
      <circle cx="8" cy="12.5" r="0.6" />
    </svg>
  )
}

export function MailIcon({ size = 16, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M2.5 4.5L8 8.5l5.5-4" />
    </svg>
  )
}

export function MailOpenIcon({ size = 16, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M2 6.5L8 2.5l6 4V13a1 1 0 01-1 1H3a1 1 0 01-1-1z" />
      <path d="M2.5 7L8 10.5 13.5 7" />
    </svg>
  )
}

export function KeyboardIcon({ size = 14, color = 'var(--text-faint)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
      <path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" />
    </svg>
  )
}

/** A compose pencil sized for the sidebar's primary button. */
export function PenIcon({ size = 18, color = 'var(--on-accent-soft)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M10.5 3l2.5 2.5L6 12.5 3 13l.5-3z" />
      <path d="M9 4.5L11.5 7" />
    </svg>
  )
}

/**
 * The app mark: the "U" of the Dock icon on an accent tile. Drawn inline so it
 * follows the theme's accent instead of shipping a second bitmap.
 */
export function LogoMark({ size = 28 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path
        d="M10.5 9v7.5a5.5 5.5 0 0011 0V9"
        fill="none"
        stroke="var(--accent-contrast)"
        strokeWidth="3.4"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** Outline when off, filled amber when on — the one icon whose fill is state. */
export function StarIcon({
  size = 16,
  color = 'var(--text-faint)',
  filled = false
}: IconProps & { filled?: boolean }): React.JSX.Element {
  return (
    <svg
      {...base(size, filled ? 'var(--star)' : color)}
      fill={filled ? 'var(--star)' : 'none'}
      aria-hidden="true"
    >
      <path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
    </svg>
  )
}

export function MinimizeIcon({ size = 14, color = 'currentColor' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M3.5 12.5h9" />
    </svg>
  )
}

/** Two arrows pointing out: make the composer big. */
export function MaximizeIcon({ size = 14, color = 'currentColor' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9" />
    </svg>
  )
}

/** Two arrows pointing in: back to the docked size. */
export function RestoreIcon({ size = 14, color = 'currentColor' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M13.5 2.5l-4 4M9.5 3v3.5H13M2.5 13.5l4-4M6.5 13V9.5H3" />
    </svg>
  )
}

export function CodeIcon({ size = 15, color = 'var(--text-muted)' }: IconProps): React.JSX.Element {
  return (
    <svg {...base(size, color)} aria-hidden="true">
      <path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />
    </svg>
  )
}
