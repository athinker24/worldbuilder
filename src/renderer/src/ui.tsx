import React, { useState } from 'react'
import Icon, { IconName } from './icons'

// Shared UI primitives. Small on purpose: these exist so screens COMPOSE rather
// than each growing its own one-off rule, which is how the stylesheet ended up
// with 47 distinct padding values and one chip class doing five different jobs.

interface SectionProps {
  title: string
  icon?: IconName
  /** Collapsed state is view-only and deliberately not persisted — it is a
      reading preference for right now, not a property of the world. */
  defaultOpen?: boolean
  action?: React.ReactNode
  /** 'warm' marks a section about the WORLD's own content — reigns, eras, where
      a thing sat on the map — as opposed to the application talking. */
  tone?: 'warm'
  children: React.ReactNode
}

/** A labelled group. Replaces the border-box idiom: heading + rhythm + a shared
    surface say "these belong together" without drawing a rectangle. */
export function Section({
  title,
  icon,
  defaultOpen = true,
  action,
  tone,
  children
}: SectionProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`section ${open ? 'open' : ''} ${tone ?? ''}`}>
      <button className="section-head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="chevron-right" size={12} className="section-caret" />
        {icon && <Icon name={icon} size={13} />}
        <span className="section-title">{title}</span>
        {/* The action belongs to the section, not the toggle — stop the click
            from also collapsing what the user just acted on. */}
        {action && (
          <span onClick={(e) => e.stopPropagation()} role="presentation">
            {action}
          </span>
        )}
      </button>
      {open && <div className="section-body">{children}</div>}
    </div>
  )
}

interface TabsProps<T extends string> {
  tabs: { key: T; label: string; icon?: IconName }[]
  active: T
  onChange: (key: T) => void
}

/** Navigation — and therefore NOT a chip. Chips were standing in for tabs in
    five places, which is why nothing distinguished a tag from a section switch. */
export function Tabs<T extends string>({
  tabs,
  active,
  onChange
}: TabsProps<T>): React.JSX.Element {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={active === t.key}
          className={`tab ${active === t.key ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

interface EmptyProps {
  icon?: IconName
  title: string
  hint?: string
  children?: React.ReactNode
}

/** An empty screen is the moment that teaches the screen. It used to be one
    muted sentence in every workspace. */
export function EmptyState({ icon, title, hint, children }: EmptyProps): React.JSX.Element {
  return (
    <div className="empty">
      {icon && <Icon name={icon} size={28} />}
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
      {children}
    </div>
  )
}

interface RowProps {
  label?: string
  children: React.ReactNode
  action?: React.ReactNode
}

/** label / value / action — the workhorse of the rail and both settings screens.
    The action is hover-revealed by CSS: a live × on every row reads as an
    invitation to delete things. */
export function Row({ label, children, action }: RowProps): React.JSX.Element {
  return (
    <div className="row">
      {label !== undefined && <span className="row-label">{label}</span>}
      <span className="row-value">{children}</span>
      {action && <span className="row-action">{action}</span>}
    </div>
  )
}

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName
  label: string
  size?: number
  danger?: boolean
  active?: boolean
  small?: boolean
}

/** A hit target around a glyph. `label` is required: an icon-only control with
    no accessible name is unusable without sight and unlabelled on hover. */
export function IconButton({
  icon,
  label,
  size = 15,
  danger,
  active,
  small,
  className,
  ...rest
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      {...rest}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={[
        'icon-btn',
        small ? 'sm' : '',
        danger ? 'danger' : '',
        active ? 'active' : '',
        className ?? ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Icon name={icon} size={size} />
    </button>
  )
}
