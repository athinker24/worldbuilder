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
  children: React.ReactNode
}

/** A labelled group. Replaces the border-box idiom: heading + rhythm + a shared
    surface say "these belong together" without drawing a rectangle. */
export function Section({
  title,
  icon,
  defaultOpen = true,
  action,
  children
}: SectionProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className={`section ${open ? 'open' : ''}`}>
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

interface SegmentedProps<T extends string> {
  options: { key: T; label: string; icon?: IconName }[]
  /** null = none of them, which is a state these groups genuinely have. */
  value: T | null
  onChange: (key: T) => void
  /** The group's own name. These controls answer a question and it should be on screen. */
  label?: string
  /** Loose pills in a wrapping row instead of one track. A track says "either/or" and is right
      for two fixed options; a list the user writes themselves (a rank ladder, the map-mode
      dimensions) is any length, and boxing a wrapping row makes a wall out of it. */
  flow?: boolean
}

/** A set of mutually exclusive view modes sharing one track.
 *
 * Toggle buttons rather than radios, and `aria-pressed` rather than `aria-checked`, because
 * that is what they are: pressing the pressed one turns it off again. A radio group cannot say
 * that, and claiming to be one would be a lie a screen reader repeats.
 *
 * NOT a chip. A chip is data — a rank tag on an entry, a folder — and chips were doing this job
 * in five places, which is why nothing on screen told you whether a thing was a label, a filter
 * or a switch. Data is a chip, navigation is a Tab, a mode is one of these.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  flow
}: SegmentedProps<T>): React.JSX.Element {
  return (
    <div className="seg-group">
      {label && <div className="seg-label">{label}</div>}
      <div className={flow ? 'seg flow' : 'seg'}>
        {options.map((o) => (
          <button
            key={o.key}
            className={`seg-item ${value === o.key ? 'on' : ''}`}
            aria-pressed={value === o.key}
            onClick={() => onChange(o.key)}
          >
            {o.icon && <Icon name={o.icon} size={12} />}
            {o.label}
          </button>
        ))}
      </div>
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
  /** For a toggle whose glyph says its own state — a starred article's star is solid. */
  filled?: boolean
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
  filled,
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
      <Icon name={icon} size={size} filled={filled} />
    </button>
  )
}
