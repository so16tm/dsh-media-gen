// The parts of DSH's shared UI primitives this half uses. The module is
// provided by the page at run time and kept external by the bundler.
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ButtonHTMLAttributes, ComponentType, ReactNode, SVGProps } from 'react'

  export const Button: ComponentType<{
    variant?: 'primary' | 'ghost' | 'outline' | 'toolbar'
    size?: 'md' | 'sm'
    icon?: ReactNode
    className?: string | undefined
    children?: ReactNode
  } & ButtonHTMLAttributes<HTMLButtonElement>>

  export interface MenuItem { id: string; label: ReactNode; disabled?: boolean }
  export type MenuEntry = MenuItem | { type: 'separator'; id: string } | { type: 'label'; id: string; text: string }
  export const Menu: ComponentType<{
    open: boolean
    anchor: ReactNode
    items?: readonly MenuEntry[]
    selectedId?: string | undefined
    onSelect?: (id: string) => void
    onClose: () => void
    align?: 'start' | 'end'
    side?: 'bottom' | 'top' | 'right'
    portal?: boolean
  }>

  export const IconChevronDownOutlineRegular: ComponentType<SVGProps<SVGSVGElement>>

  export const Modal: ComponentType<{
    open: boolean
    onClose: () => void
    title: string
    description?: string
    children?: ReactNode
    footer?: ReactNode
    closeLabel: string
  }>
}
