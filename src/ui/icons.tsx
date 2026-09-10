// Local static SVG icons. No remote assets, no inline styles.
type IconProps = Readonly<{ size?: number }>;

function base(props: IconProps, children: React.ReactNode, viewBox = '0 0 16 16') {
  const size = props.size ?? 15;
  return (
    <svg className="ic" width={size} height={size} viewBox={viewBox} aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      {children}
    </svg>
  );
}

export function IconOpen(props: IconProps) {
  return base(props, <>
    <path d="M2 13.5v-11h4l1.5 2h6.5v9z" />
    <path d="M2 6.5h12" />
  </>);
}

export function IconFolder(props: IconProps) {
  return base(props, <>
    <path d="M1.8 13.2V3.3h4.2l1.6 2h6.6v7.9z" />
  </>);
}

export function IconUndo(props: IconProps) {
  return base(props, <>
    <path d="M6.5 3.5 3 7l3.5 3.5" />
    <path d="M3 7h6.5a3.5 3.5 0 0 1 0 7H7" />
  </>);
}

export function IconRedo(props: IconProps) {
  return base(props, <>
    <path d="M9.5 3.5 13 7l-3.5 3.5" />
    <path d="M13 7H6.5a3.5 3.5 0 0 0 0 7H9" />
  </>);
}

export function IconSave(props: IconProps) {
  return base(props, <>
    <path d="M3 13.5h10a.5.5 0 0 0 .5-.5V4.6L11 2H3a.5.5 0 0 0-.5.5V13a.5.5 0 0 0 .5.5z" />
    <path d="M5 2v3.2h5.2V2" />
    <path d="M5 13.5V9.4h6v4.1" />
  </>);
}

export function IconPdf(props: IconProps) {
  return base(props, <>
    <path d="M4 1.8h5.5L12.5 5v9.2H4z" />
    <path d="M9.3 1.8V5h3.2" />
    <path d="M6 10.8V8.2h1.4a1.3 1.3 0 0 1 0 2.6H6" />
  </>);
}

export function IconPanelHide(props: IconProps) {
  return base(props, <>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M10 3v10" />
    <path d="m7.2 6.5-1.7 1.5 1.7 1.5" />
  </>);
}

export function IconPanelShow(props: IconProps) {
  return base(props, <>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M10 3v10" />
    <path d="m5.4 6.5 1.7 1.5-1.7 1.5" />
  </>);
}

export function IconFloat(props: IconProps) {
  return base(props, <>
    <rect x="1.8" y="4.5" width="8" height="8" rx="1" />
    <path d="M6.2 4.5v-1.9a.8.8 0 0 1 .8-.8h6.4a.8.8 0 0 1 .8.8v6.4a.8.8 0 0 1-.8.8h-1.9" />
  </>);
}

export function IconDock(props: IconProps) {
  return base(props, <>
    <rect x="2" y="3" width="12" height="10" rx="1" />
    <path d="M10 3v10" />
  </>);
}

export function IconMenu(props: IconProps) {
  return base(props, <>
    <circle cx="3" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="13" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </>);
}

export function IconClose(props: IconProps) {
  return base(props, <>
    <path d="m4 4 8 8M12 4l-8 8" />
  </>);
}

export function IconCheck(props: IconProps) {
  return base(props, <>
    <path d="m3 8.5 3.2 3.2L13 4.8" />
  </>);
}
