/**
 * Line icons of the Verwaltung, in the stroke style of Icons.tsx. Kept apart
 * so the mailbox's icon set does not grow by a dozen shapes it never shows.
 */

interface IconProps {
  size?: number
  color?: string
}

function Stroke({
  size = 18,
  color = 'currentColor',
  children
}: IconProps & { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

export function HomeIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9v11h14V9" />
      <path d="M10 20v-6h4v6" />
    </Stroke>
  )
}

export function GlobeIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
    </Stroke>
  )
}

export function MailboxIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </Stroke>
  )
}

export function RouteIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="5" r="2" />
      <path d="M8 19h8.5a3.5 3.5 0 0 0 0-7h-9a3.5 3.5 0 0 1 0-7H16" />
    </Stroke>
  )
}

export function DeliveryIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4z" />
    </Stroke>
  )
}

export function UsersIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7" />
      <path d="M18 14a6.5 6.5 0 0 1 3.5 6" />
    </Stroke>
  )
}

export function IdCardIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="11" r="2" />
      <path d="M6 16a3 3 0 0 1 6 0" />
      <path d="M15 10h3M15 14h3" />
    </Stroke>
  )
}

export function TemplateIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8M8 17h5" />
    </Stroke>
  )
}

export function BellIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </Stroke>
  )
}

export function QueueIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M4 6h16M4 12h16M4 18h10" />
      <path d="m17 16 3 2-3 2" />
    </Stroke>
  )
}

export function PulseIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </Stroke>
  )
}

export function DatabaseIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </Stroke>
  )
}

export function GearIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </Stroke>
  )
}

export function ArrowLeftIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </Stroke>
  )
}

export function PlusIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M12 5v14M5 12h14" />
    </Stroke>
  )
}

export function CheckCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </Stroke>
  )
}

export function AlertIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4M12 17h.01" />
    </Stroke>
  )
}

export function CircleIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="8" />
    </Stroke>
  )
}

export function MinusCircleIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12h8" />
    </Stroke>
  )
}

export function CopyIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </Stroke>
  )
}

export function ArrowUpIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="m6 14 6-6 6 6" />
    </Stroke>
  )
}

export function ArrowDownIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="m6 10 6 6 6-6" />
    </Stroke>
  )
}

export function EditIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </Stroke>
  )
}

export function DeleteIcon(props: IconProps): React.JSX.Element {
  return (
    <Stroke {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
    </Stroke>
  )
}
