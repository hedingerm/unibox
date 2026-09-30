interface Props {
  size?: number
}

function svg(size: number): Record<string, string | number> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round'
  }
}

export function BoldIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M4.5 2.5h4a2.5 2.5 0 010 5h-4z" />
      <path d="M4.5 7.5h4.6a3 3 0 010 6H4.5z" />
    </svg>
  )
}

export function ItalicIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M10 2.5H6.5M9.5 13.5H6M9 2.5L7 13.5" />
    </svg>
  )
}

export function UnderlineIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M4.5 2.5v5a3.5 3.5 0 007 0v-5" />
      <path d="M3.5 13.5h9" />
    </svg>
  )
}

export function StrikeIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M2.5 8h11" />
      <path d="M11.5 4.5A3 3 0 008.5 3H7a2.4 2.4 0 00-.6 4.6" />
      <path d="M4.5 11.5A3 3 0 007.5 13H9a2.4 2.4 0 00.9-4.6" />
    </svg>
  )
}

export function BulletListIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M6 4h8M6 8h8M6 12h8" />
      <circle cx="3" cy="4" r="0.8" fill="currentColor" />
      <circle cx="3" cy="8" r="0.8" fill="currentColor" />
      <circle cx="3" cy="12" r="0.8" fill="currentColor" />
    </svg>
  )
}

export function OrderedListIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M6 4h8M6 8h8M6 12h8" />
      <path d="M2.2 2.8h.9v2.6M2 11.2h1.6L2 13h1.6" />
    </svg>
  )
}

export function QuoteIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M3 3.5v9" />
      <path d="M6.5 5h6.5M6.5 8h6.5M6.5 11h4" />
    </svg>
  )
}

export function CodeIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M5.5 4.5L2 8l3.5 3.5" />
      <path d="M10.5 4.5L14 8l-3.5 3.5" />
    </svg>
  )
}

export function LinkIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M6.8 9.2a2.6 2.6 0 000 0 2.6 2.6 0 003.7 0l2-2a2.6 2.6 0 10-3.7-3.7l-.9.9" />
      <path d="M9.2 6.8a2.6 2.6 0 00-3.7 0l-2 2a2.6 2.6 0 103.7 3.7l.9-.9" />
    </svg>
  )
}

export function TableIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M2 6.5h12M6 6.5V13M10 6.5V13" />
    </svg>
  )
}

export function ImageIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <circle cx="5.5" cy="6.5" r="1" />
      <path d="M2.5 11.5l3.5-3 3 2.5 2-1.5 2.5 2" />
    </svg>
  )
}

export function ClearFormatIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M5 3h7M9.5 3L7 13" />
      <path d="M3 13h6" />
      <path d="M11 9.5l3 3M14 9.5l-3 3" />
    </svg>
  )
}

export function CutIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <circle cx="4" cy="12" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M5.5 10.5L12 2M10.5 10.5L4 2" />
    </svg>
  )
}

export function CopyIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1.5 1.5 0 00-1.5-1.5H4a1.5 1.5 0 00-1.5 1.5V9A1.5 1.5 0 004 10.5h2" />
    </svg>
  )
}

export function PasteIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M6 3H4.5A1.5 1.5 0 003 4.5v9A1.5 1.5 0 004.5 15h7a1.5 1.5 0 001.5-1.5v-9A1.5 1.5 0 0011.5 3H10" />
      <rect x="6" y="1.5" width="4" height="2.5" rx="0.75" />
    </svg>
  )
}

export function UnlinkIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M6.5 9.5L5 11a2.5 2.5 0 01-3.5-3.5L3 6" />
      <path d="M9.5 6.5L11 5a2.5 2.5 0 013.5 3.5L13 10" />
      <path d="M2 2l12 12" />
    </svg>
  )
}

export function OpenLinkIcon({ size = 14 }: Props): React.JSX.Element {
  return (
    <svg {...svg(size)} aria-hidden="true">
      <path d="M9.5 2.5h4v4" />
      <path d="M13.5 2.5L7 9" />
      <path d="M12 9.5v3A1.5 1.5 0 0110.5 14h-7A1.5 1.5 0 012 12.5v-7A1.5 1.5 0 013.5 4h3" />
    </svg>
  )
}
