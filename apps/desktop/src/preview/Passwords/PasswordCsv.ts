import { passwordOrigin, type ImportedPassword, type PasswordReadResult } from "./PasswordEntry.ts";

/** RFC 4180 records: quoted fields may hold commas, doubled quotes and newlines. */
export const parseCsvRecords = (text: string): ReadonlyArray<ReadonlyArray<string>> => {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  const input = text.startsWith("﻿") ? text.slice(1) : text;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];

    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  return records.filter((row) => row.some((value) => value.trim() !== ""));
};

// 1Password exports `Title,Url,Username,Password,…`; Apple Passwords exports
// `Title,URL,Username,Password,Notes,OTPAuth`. Older 1Password and Bitwarden-style
// exports use the `login_*` names.
const URL_HEADERS = new Set(["url", "website", "login_uri", "login url"]);
const USERNAME_HEADERS = new Set(["username", "login_username", "login name"]);
const PASSWORD_HEADERS = new Set(["password", "login_password"]);

/** Returns `undefined` when the file has no URL and password columns at all. */
export const readPasswordCsv = (text: string): PasswordReadResult | undefined => {
  const [header, ...rows] = parseCsvRecords(text);
  if (header === undefined) {
    return undefined;
  }

  const columns = header.map((name) => name.trim().toLowerCase());
  const urlColumn = columns.findIndex((name) => URL_HEADERS.has(name));
  const usernameColumn = columns.findIndex((name) => USERNAME_HEADERS.has(name));
  const passwordColumn = columns.findIndex((name) => PASSWORD_HEADERS.has(name));
  if (urlColumn === -1 || passwordColumn === -1) {
    return undefined;
  }

  const passwords: ImportedPassword[] = [];
  let skipped = 0;
  for (const row of rows) {
    const origin = passwordOrigin(row[urlColumn] ?? "");
    const password = row[passwordColumn] ?? "";
    if (origin === undefined || password === "") {
      skipped += 1;
      continue;
    }
    passwords.push({
      origin,
      username: usernameColumn === -1 ? "" : (row[usernameColumn] ?? "").trim(),
      password,
    });
  }

  return { passwords, skipped };
};
