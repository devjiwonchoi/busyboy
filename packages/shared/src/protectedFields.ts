/**
 * Which form fields hold sign-in or contact details an agent must not read
 * back. Their values are replaced with a mask in every agent-visible output.
 */

/** What the page tells us about one field, gathered in the page's own world. */
export interface FieldDescriptor {
  /** Lower-case tag name, e.g. `input`. */
  readonly tag: string;
  /** Lower-case `type` attribute; "" when absent. */
  readonly type: string;
  /** Lower-case `autocomplete` attribute; "" when absent. */
  readonly autocomplete: string;
  /** name, id, placeholder, aria-label, title, and associated label text. */
  readonly hints: ReadonlyArray<string>;
  /** Computed `-webkit-text-security`; "" or "none" when the field draws text. */
  readonly textSecurity: string;
  readonly contentEditable: boolean;
}

export type ProtectedFieldReason = "type" | "autocomplete" | "hint" | "textSecurity";

/**
 * Self-contained so it can be serialized into page scripts: no outer
 * references, every table lives inside. Returns why a field is protected, or
 * null when it isn't.
 */
export function classifyProtectedField(field: FieldDescriptor): ProtectedFieldReason | null {
  const PROTECTED_TYPES = ["password", "email", "tel", "hidden"];
  const PROTECTED_AUTOCOMPLETE = [
    "username",
    "current-password",
    "new-password",
    "one-time-code",
    "email",
    "tel",
    "tel-national",
    "tel-local",
    "tel-country-code",
    "tel-area-code",
    "tel-local-prefix",
    "tel-local-suffix",
    "tel-extension",
  ];
  /**
   * Each concept lists words matched against the field's hints after they are
   * split into lower-case words (camelCase and snake_case split too). Phrases
   * match consecutive words.
   */
  const KEYWORDS: ReadonlyArray<{
    readonly concept: string;
    readonly words: ReadonlyArray<string>;
  }> = [
    {
      concept: "username",
      words: ["username", "user", "userid", "login", "loginid", "account", "acct"],
    },
    { concept: "email", words: ["email", "e mail", "mail", "mailaddress"] },
    { concept: "password", words: ["password", "passwd", "pwd", "pass", "passphrase"] },
    { concept: "passcode", words: ["passcode", "pin", "pincode", "pin code"] },
    {
      concept: "one-time code",
      words: [
        "otp",
        "totp",
        "one time",
        "onetime",
        "verification",
        "verify code",
        "security code",
        "auth code",
        "authentication code",
        "2fa",
        "mfa",
        "two factor",
      ],
    },
    { concept: "phone", words: ["phone", "telephone", "tel", "mobile", "cell", "msisdn"] },
  ];

  const tag = field.tag.toLowerCase();
  const isField =
    tag === "input" || tag === "textarea" || tag === "select" || field.contentEditable;
  if (!isField) return null;

  if (tag === "input" && PROTECTED_TYPES.includes(field.type.toLowerCase())) return "type";

  const tokens = field.autocomplete.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.some((token) => PROTECTED_AUTOCOMPLETE.includes(token) || token.startsWith("cc-"))) {
    return "autocomplete";
  }

  const security = field.textSecurity.trim().toLowerCase();
  if (security !== "" && security !== "none") return "textSecurity";

  for (const hint of field.hints) {
    const words = hint
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z\d]+/)
      .filter(Boolean);
    if (words.length === 0) continue;
    const text = ` ${words.join(" ")} `;
    for (const { words: needles } of KEYWORDS) {
      if (needles.some((needle) => text.includes(` ${needle} `))) return "hint";
    }
  }
  return null;
}

/** Values this short are not scrubbed from free-form results; they'd hit unrelated text. */
export const MIN_SCRUBBED_VALUE_LENGTH = 3;

/**
 * Replaces every occurrence of a protected value inside a JSON-like result,
 * keeping its shape. Object keys are scrubbed too.
 */
export function scrubProtectedValues(
  value: unknown,
  secrets: ReadonlyArray<string>,
  mask: string,
): unknown {
  const needles = [
    ...new Set(secrets.filter((secret) => secret.length >= MIN_SCRUBBED_VALUE_LENGTH)),
  ]
    // Longest first, so a value inside another never leaves the rest showing.
    .toSorted((a, b) => b.length - a.length);
  if (needles.length === 0) return value;
  const scrubText = (text: string) => {
    let out = text;
    for (const needle of needles) out = out.split(needle).join(mask);
    return out;
  };
  const walk = (node: unknown, depth: number): unknown => {
    if (typeof node === "string") return scrubText(node);
    if (depth > 64 || node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, item]) => [
        scrubText(key),
        walk(item, depth + 1),
      ]),
    );
  };
  return walk(value, 0);
}

/**
 * Fields an agent may not type into at all: passwords and one-time codes.
 * Agents sign in through preview_sign_in, where the person enters or picks
 * the login. Other protected fields (a username, an email) may be typed into;
 * their values are still masked in what the agent reads back.
 */
export function isSecretEntryField(field: FieldDescriptor): boolean {
  if (field.tag === "input" && field.type === "password") return true;
  const tokens = field.autocomplete.split(/\s+/);
  if (["current-password", "new-password", "one-time-code"].some((token) => tokens.includes(token)))
    return true;
  const security = field.textSecurity.trim();
  if (security !== "" && security !== "none") return true;
  const text = ` ${field.hints
    .map((hint) =>
      hint
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z\d]+/)
        .filter(Boolean)
        .join(" "),
    )
    .join(" | ")} `;
  return [
    "password",
    "passwd",
    "pwd",
    "passcode",
    "pin",
    "otp",
    "totp",
    "one time",
    "onetime",
    "verification",
    "security code",
    "auth code",
    "authentication code",
    "2fa",
    "mfa",
  ].some((needle) => text.includes(` ${needle} `));
}
