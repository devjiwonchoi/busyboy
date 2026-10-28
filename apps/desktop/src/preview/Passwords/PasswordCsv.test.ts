import { describe, expect, it } from "@effect/vitest";

import { parseCsvRecords, readPasswordCsv } from "./PasswordCsv.ts";

describe("parseCsvRecords", () => {
  it("keeps commas, doubled quotes and newlines inside quoted fields", () => {
    expect(parseCsvRecords('a,"b, ""c""\nd",e\r\nf,g,h\n')).toEqual([
      ["a", 'b, "c"\nd', "e"],
      ["f", "g", "h"],
    ]);
  });

  it("drops a byte-order mark and blank lines", () => {
    expect(parseCsvRecords("﻿x,y\n\n1,2")).toEqual([
      ["x", "y"],
      ["1", "2"],
    ]);
  });
});

describe("readPasswordCsv", () => {
  it("reads a 1Password export", () => {
    const csv = [
      "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes",
      'GitHub,https://github.com/login,octo,"p,ss",,false,false,,',
    ].join("\n");
    expect(readPasswordCsv(csv)).toEqual({
      passwords: [{ origin: "https://github.com", username: "octo", password: "p,ss" }],
      skipped: 0,
    });
  });

  it("reads an Apple Passwords export and skips rows it cannot fill", () => {
    const csv = [
      "Title,URL,Username,Password,Notes,OTPAuth",
      "Example,https://www.example.com/,me@example.com,secret,,",
      "App,android://hash@com.example.app/,me,secret,,",
      "No password,https://example.org,me,,,",
    ].join("\n");
    expect(readPasswordCsv(csv)).toEqual({
      passwords: [
        { origin: "https://www.example.com", username: "me@example.com", password: "secret" },
      ],
      skipped: 2,
    });
  });

  it("rejects a file without URL and password columns", () => {
    expect(readPasswordCsv("name,notes\nfoo,bar")).toBeUndefined();
    expect(readPasswordCsv("")).toBeUndefined();
  });
});
