// why: Field types follow codex-cli 0.167.0 and the MCP 2025-11-25 form schema.
type Choice = { const: string; title: string };

type ElicitationField = {
  type?: string;
  default?: unknown;
  enum?: string[];
  oneOf?: Choice[];
  items?: { enum?: string[]; anyOf?: Choice[] };
};

export type ElicitationSchema = {
  properties?: Record<string, ElicitationField | undefined>;
  required?: string[];
};

function hasChoices(field: ElicitationField) {
  if (field.type === "boolean") return true;
  if (field.type === "array" && field.items?.anyOf) return field.items.anyOf.length > 0;
  if (field.oneOf) return field.oneOf.length > 0;
  const values = field.type === "array" ? (field.items?.enum ?? []) : (field.enum ?? []);
  return values.length > 0;
}

export function unfillableFields(schema: ElicitationSchema) {
  const properties = schema.properties ?? {};
  return (schema.required ?? []).filter((key) => {
    const field = properties[key];
    return !field || (!hasChoices(field) && field.default === undefined);
  });
}

// why: An accepted form sends only the defaults the server declared, or nothing when a required field has none.
export function elicitationDefaults(schema: ElicitationSchema): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.properties ?? {})) {
    if (field?.default !== undefined) content[key] = field.default;
  }
  const missing = (schema.required ?? []).some((key) => content[key] === undefined);
  return missing ? {} : content;
}
