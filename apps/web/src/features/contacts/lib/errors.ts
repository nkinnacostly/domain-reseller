/** next-safe-action's formatted validation errors: nested by the input's path. */
type Formatted = { _errors?: string[] } & { [key: string]: Formatted | string[] | undefined }

/** The first message at a path in a formatted error tree, if there is one. */
export function errorAt(errors: unknown, path: string[]): string | undefined {
  let node = errors as Formatted | undefined
  for (const key of path) node = node?.[key] as Formatted | undefined
  return node?._errors?.[0]
}
