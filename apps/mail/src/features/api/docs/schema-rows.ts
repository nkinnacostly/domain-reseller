/**
 * A JSON Schema (as `jsonSchemaOf` makes it from the API's Zod schemas) as
 * the rows of a field table: each field's path, its type in words, whether
 * it is required, and its description. Objects and arrays of objects open
 * into their own fields (`attachments[].filename`), so the reference shows
 * every field the API takes or answers — and nothing it does not.
 */

export type FieldRow = { name: string; type: string; required: boolean; description: string }

type Schema = Record<string, unknown>

const isSchema = (value: unknown): value is Schema =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function asList(value: unknown): Schema[] {
  return Array.isArray(value) ? value.filter(isSchema) : []
}

/** A schema's type in a few words: "string (uuid)", "string or array of strings", "one of: a, b". */
export function typeWords(schema: Schema): string {
  if ('const' in schema) return JSON.stringify(schema.const)
  if (Array.isArray(schema.enum)) return `one of: ${schema.enum.map(String).join(', ')}`
  const options = asList(schema.anyOf ?? schema.oneOf)
  if (options.length > 0) return options.map(typeWords).join(' or ')
  const type = schema.type
  if (Array.isArray(type))
    return type.map((one) => typeWords({ ...schema, type: one })).join(' or ')
  switch (type) {
    case 'string': {
      if (schema.format === 'uuid') return 'string (uuid)'
      if (schema.format === 'date-time') return 'string (ISO 8601 date and time)'
      if (schema.format === 'email') return 'string (email address)'
      return 'string'
    }
    case 'array':
      return isSchema(schema.items) ? `array of ${plural(typeWords(schema.items))}` : 'array'
    case 'object':
      return isSchema(schema.additionalProperties)
        ? `object of ${plural(typeWords(schema.additionalProperties))}`
        : 'object'
    case 'null':
      return 'null'
    case undefined:
      return 'any'
    default:
      return String(type)
  }
}

function plural(words: string): string {
  if (words.startsWith('one of')) return `values ${words}`
  return words.replace(/^(string|integer|number|boolean|object|array|null)\b/, '$1s')
}

/** The object schema inside a field, when it has fields of its own to list. */
function objectWithin(schema: Schema): { schema: Schema; suffix: string } | null {
  if (schema.type === 'object' && isSchema(schema.properties)) return { schema, suffix: '' }
  if (schema.type === 'array' && isSchema(schema.items)) {
    const inner = objectWithin(schema.items)
    return inner ? { schema: inner.schema, suffix: `[]${inner.suffix}` } : null
  }
  for (const option of asList(schema.anyOf)) {
    const inner = objectWithin(option)
    if (inner) return inner
  }
  return null
}

export function fieldRows(schema: Schema, prefix = ''): FieldRow[] {
  const inner = objectWithin(schema)
  if (!inner) return []
  const properties = inner.schema.properties as Record<string, unknown>
  const required = new Set(Array.isArray(inner.schema.required) ? inner.schema.required : [])
  const base = `${prefix}${inner.suffix}`
  return Object.entries(properties).flatMap(([name, value]) => {
    if (!isSchema(value)) return []
    const path = base ? `${base}.${name}` : name
    const row: FieldRow = {
      name: path,
      type: typeWords(value),
      required: required.has(name),
      description: typeof value.description === 'string' ? value.description : '',
    }
    return [row, ...fieldRows(value, path)]
  })
}
