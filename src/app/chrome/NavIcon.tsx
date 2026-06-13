type Kind = 'home' | 'config' | 'knowledge' | 'graph' | 'code' | 'sessions' | 'machines' | 'profile' | 'history' | 'settings'

export function NavIcon({ kind, size = 22 }: { kind: Kind; size?: number }) {
  const props = {
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    viewBox: '0 0 24 24',
  }
  switch (kind) {
    case 'home':
      // Stylised ◈ — outer diamond + inner diamond, matching the title bar mark.
      return (
        <svg {...props}>
          <path d="M12 3 L21 12 L12 21 L3 12 Z" />
          <path d="M12 8 L16 12 L12 16 L8 12 Z" />
        </svg>
      )
    case 'config':
      return (
        <svg {...props}>
          <circle cx="9" cy="10" r="3" />
          <path d="M9 4.5v1.4 M9 14.1v1.4 M3.5 10h1.4 M13.1 10h1.4
                   M5.1 6.1l1 1 M11.9 12.9l1 1 M5.1 13.9l1-1 M11.9 7.1l1-1" />
          <circle cx="16.5" cy="16.5" r="2" />
          <path d="M16.5 13v0.9 M16.5 19.1v0.9 M13 16.5h0.9 M19.1 16.5h0.9
                   M14.1 14.1l0.65 0.65 M18.25 18.25l0.65 0.65
                   M14.1 18.9l0.65-0.65 M18.25 14.75l0.65-0.65" />
        </svg>
      )
    case 'knowledge':
      return (
        <svg {...props}>
          <path d="M12 5.5
                   c-0.6-1.2-2-1.8-3.3-1.4
                   c-1.4 0.4-2.3 1.7-2.2 3
                   c-1.4 0.2-2.5 1.3-2.5 2.7
                   c0 0.9 0.4 1.7 1.1 2.2
                   c-0.6 0.5-1 1.3-1 2.1
                   c0 1.3 0.9 2.4 2.2 2.7
                   c0.1 1.4 1.3 2.5 2.7 2.5
                   c1.2 0 2.2-0.7 2.7-1.8
                   V5.5z" />
          <path d="M12 5.5
                   c0.6-1.2 2-1.8 3.3-1.4
                   c1.4 0.4 2.3 1.7 2.2 3
                   c1.4 0.2 2.5 1.3 2.5 2.7
                   c0 0.9-0.4 1.7-1.1 2.2
                   c0.6 0.5 1 1.3 1 2.1
                   c0 1.3-0.9 2.4-2.2 2.7
                   c-0.1 1.4-1.3 2.5-2.7 2.5
                   c-1.2 0-2.2-0.7-2.7-1.8
                   V5.5z" />
          <path d="M8 8.5c0.6 0.3 1.2 0.5 1.8 0.4 M7.2 12.2c0.8-0.2 1.6-0.1 2.3 0.3
                   M16 8.5c-0.6 0.3-1.2 0.5-1.8 0.4 M16.8 12.2c-0.8-0.2-1.6-0.1-2.3 0.3" />
        </svg>
      )
    case 'graph':
      return (
        <svg {...props}>
          <line x1="6" y1="6" x2="12" y2="11" />
          <line x1="18" y1="6" x2="12" y2="11" />
          <line x1="12" y1="11" x2="6" y2="18" />
          <line x1="12" y1="11" x2="18" y2="18" />
          <line x1="6" y1="6" x2="18" y2="6" />
          <line x1="6" y1="18" x2="18" y2="18" />
          <circle cx="6" cy="6" r="1.8" />
          <circle cx="18" cy="6" r="1.8" />
          <circle cx="12" cy="11" r="2.2" />
          <circle cx="6" cy="18" r="1.8" />
          <circle cx="18" cy="18" r="1.8" />
        </svg>
      )
    case 'code':
      // Angle brackets with a slash — </> source glyph.
      return (
        <svg {...props}>
          <polyline points="8,8 4,12 8,16" />
          <polyline points="16,8 20,12 16,16" />
          <line x1="13.5" y1="6" x2="10.5" y2="18" />
        </svg>
      )
    case 'sessions':
      return (
        <svg {...props}>
          <path d="M13.5 3 L5 13.5 H11 L10 21 L19 9.5 H13 L13.5 3 Z" />
        </svg>
      )
    case 'machines':
      // Hub-and-spoke: central node connected to four satellite nodes — federation topology.
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="2.5" />
          <circle cx="5" cy="5" r="1.8" />
          <circle cx="19" cy="5" r="1.8" />
          <circle cx="5" cy="19" r="1.8" />
          <circle cx="19" cy="19" r="1.8" />
          <line x1="9.8" y1="9.8" x2="6.3" y2="6.3" />
          <line x1="14.2" y1="9.8" x2="17.7" y2="6.3" />
          <line x1="9.8" y1="14.2" x2="6.3" y2="17.7" />
          <line x1="14.2" y1="14.2" x2="17.7" y2="17.7" />
        </svg>
      )
    case 'profile':
      // Person reflected in a mirror line — the AI's perception of the human.
      // Head + shoulders, with a vertical rule suggesting the reflective surface.
      return (
        <svg {...props}>
          <line x1="12" y1="3.5" x2="12" y2="20.5" strokeDasharray="2 2" opacity="0.5" />
          <circle cx="7.5" cy="9" r="2.6" />
          <path d="M3.4 18.5c0-2.5 1.9-4.3 4.1-4.3s4.1 1.8 4.1 4.3" />
          <circle cx="16.5" cy="9" r="2.6" opacity="0.5" />
          <path d="M20.6 18.5c0-2.5-1.9-4.3-4.1-4.3s-4.1 1.8-4.1 4.3" opacity="0.5" />
        </svg>
      )
    case 'history':
      return (
        <svg {...props}>
          <path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
          <polyline points="3.5,3.5 3.5,8 8,8" />
          <polyline points="12,7 12,12 15.5,14" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="2.6" />
          <path d="M12 3v2.2 M12 18.8V21 M3 12h2.2 M18.8 12H21
                   M5.6 5.6l1.55 1.55 M16.85 16.85l1.55 1.55
                   M5.6 18.4l1.55-1.55 M16.85 7.15l1.55-1.55" />
        </svg>
      )
  }
}
