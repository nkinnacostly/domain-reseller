/** The panel's shared card styles (components/layout/panel), for the overview's blocks. */
export { FOCUS, PANEL, ROUND_LINK } from '@/components/layout/panel'

export const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`
