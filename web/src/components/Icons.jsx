/** Line icons in the prototype's style: 24-unit grid, round caps. */
function Icon({ size = 17, strokeWidth = 1.9, children, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const WarningIcon = (p) => (
  <Icon strokeWidth={2} {...p}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 8v4" />
    <path d="M12 16h.01" />
  </Icon>
);

export const ExternalIcon = (p) => (
  <Icon {...p}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Icon>
);

export const ExpandIcon = (p) => (
  <Icon {...p}>
    <path d="M21 8V5a2 2 0 0 0-2-2h-3" />
    <path d="M3 8V5a2 2 0 0 1 2-2h3" />
    <path d="M21 16v3a2 2 0 0 1-2 2h-3" />
    <path d="M3 16v3a2 2 0 0 0 2 2h3" />
  </Icon>
);

export const LinkOffIcon = (p) => (
  <Icon {...p}>
    <path d="M9 17H7A5 5 0 0 1 7 7" />
    <path d="M15 7h2a5 5 0 0 1 4 8" />
    <path d="M8 12h4" />
    <path d="m2 2 20 20" />
  </Icon>
);

export const CubeIcon = (p) => (
  <Icon {...p}>
    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
    <path d="m3.3 7 8.7 5 8.7-5" />
    <path d="M12 22V12" />
  </Icon>
);
