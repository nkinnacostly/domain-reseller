import {
  API_OPERATIONS,
  API_SCHEMAS,
  type ApiOperation,
  accessWords,
  EMAIL_LIMITS,
  jsonSchemaOf,
  queryParameters,
} from '@dr/shared/mail'
import { cn } from '@/lib/utils'
import { DocsTable } from './docs-frame'
import { type FieldRow, fieldRows, typeWords } from './schema-rows'

/**
 * The API reference (MAIL-SPEC §6), generated from the same list of
 * operations and the same Zod schemas as `/api/v1/openapi.json` — which the
 * handlers validate with. Nothing here is written by hand but the layout.
 */

const METHOD_TONE: Record<ApiOperation['method'], string> = {
  GET: 'bg-tone-info text-tone-info-foreground',
  POST: 'bg-tone-success text-tone-success-foreground',
  PATCH: 'bg-tone-warning text-tone-warning-foreground',
  DELETE: 'bg-tone-danger text-tone-danger-foreground',
}

export function MethodBadge({ method }: { method: ApiOperation['method'] }) {
  return (
    <span
      className={cn(
        'inline-flex rounded-md px-2 py-0.5 font-mono text-xs font-semibold',
        METHOD_TONE[method],
      )}
    >
      {method}
    </span>
  )
}

const schemaOf = (name: keyof typeof API_SCHEMAS) => {
  const { schema, io } = API_SCHEMAS[name]
  return jsonSchemaOf(schema, io)
}

function FieldTable({ label, rows }: { label: string; rows: FieldRow[] }) {
  return (
    <DocsTable
      label={label}
      head={['Field', 'Type', 'Description']}
      rows={rows.map((row) => [
        <span key="name" className="whitespace-nowrap">
          <code>{row.name}</code>
          {row.required ? (
            <span className="ml-1.5 text-xs font-medium text-tone-danger-foreground">required</span>
          ) : null}
        </span>,
        <span key="type" className="text-muted-foreground">
          {row.type}
        </span>,
        row.description,
      ])}
    />
  )
}

function Operation({ operation }: { operation: ApiOperation }) {
  const body = operation.body ? schemaOf(operation.body) : null
  const answer = schemaOf(operation.response)
  const query = operation.query ? queryParameters(operation.query) : []
  return (
    <section
      id={operation.id}
      aria-labelledby={`${operation.id}-heading`}
      data-operation={`${operation.method} ${operation.path}`}
      className="scroll-mt-8 border-t border-border pt-10 first:border-t-0 first:pt-0"
    >
      <h2
        id={`${operation.id}-heading`}
        className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight"
      >
        <MethodBadge method={operation.method} />
        <code className="break-all font-mono text-base">{operation.path}</code>
      </h2>
      <p className="font-medium">{operation.summary}</p>
      <p>{operation.description}</p>
      <p className="text-sm text-muted-foreground">{accessWords(operation.access)}</p>

      {operation.pathId ? (
        <>
          <h3 className="mt-6 font-semibold">Path</h3>
          <FieldTable
            label={`${operation.method} ${operation.path}: path`}
            rows={[
              { name: 'id', type: 'string (uuid)', required: true, description: operation.pathId },
            ]}
          />
        </>
      ) : null}

      {query.length > 0 ? (
        <>
          <h3 className="mt-6 font-semibold">Query parameters</h3>
          <FieldTable
            label={`${operation.method} ${operation.path}: query parameters`}
            rows={query.map((parameter) => ({
              name: parameter.name,
              type: typeWords(parameter.schema),
              required: false,
              description: parameter.description,
            }))}
          />
        </>
      ) : null}

      {operation.idempotent ? (
        <>
          <h3 className="mt-6 font-semibold">Headers</h3>
          <FieldTable
            label={`${operation.method} ${operation.path}: headers`}
            rows={[
              {
                name: 'Idempotency-Key',
                type: `string, 1 to ${EMAIL_LIMITS.maxIdempotencyKeyChars} printable ASCII characters`,
                required: false,
                description:
                  'The same key and body within 24 hours answers the first answer again and queues nothing more. See Idempotency.',
              },
            ]}
          />
        </>
      ) : null}

      {body ? (
        <>
          <h3 className="mt-6 font-semibold">Body</h3>
          {body.type === 'array' ? (
            <p>
              A JSON array of 1 to {EMAIL_LIMITS.maxBatch} emails, each with the fields of{' '}
              <a href="#sendEmail">POST /emails</a>.
            </p>
          ) : (
            <FieldTable
              label={`${operation.method} ${operation.path}: body`}
              rows={fieldRows(body)}
            />
          )}
        </>
      ) : null}

      <h3 className="mt-6 font-semibold">Answer</h3>
      {operation.response === 'OpenApi' ? (
        <p>This API’s OpenAPI 3.1 document, as JSON.</p>
      ) : (
        <FieldTable
          label={`${operation.method} ${operation.path}: answer`}
          rows={fieldRows(answer)}
        />
      )}

      {operation.errors.length > 0 ? (
        <>
          <h3 className="mt-6 font-semibold">Errors</h3>
          <DocsTable
            label={`${operation.method} ${operation.path}: errors`}
            head={['Status', 'name', 'When']}
            rows={operation.errors.map((error) => [
              <code key="status">{error.status}</code>,
              <span key="names" className="whitespace-nowrap">
                {error.names.map((name, index) => (
                  <span key={name}>
                    {index > 0 ? ', ' : ''}
                    <code>{name}</code>
                  </span>
                ))}
              </span>,
              error.when,
            ])}
          />
        </>
      ) : null}
    </section>
  )
}

export function ApiReference() {
  return (
    <div className="space-y-10">
      <nav aria-label="Endpoints">
        <ul className="mt-0! list-none! space-y-1! pl-0!">
          {API_OPERATIONS.map((operation) => (
            <li key={operation.id} className="flex min-h-11 flex-wrap items-center gap-2">
              <MethodBadge method={operation.method} />
              <a href={`#${operation.id}`} className="break-all">
                {operation.path}
              </a>
              <span className="text-sm text-muted-foreground">— {operation.summary}</span>
            </li>
          ))}
        </ul>
      </nav>
      {API_OPERATIONS.map((operation) => (
        <Operation key={operation.id} operation={operation} />
      ))}
    </div>
  )
}
