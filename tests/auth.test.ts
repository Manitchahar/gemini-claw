import { describe, expect, it } from "vitest";

import { isAllowedUser, isPrivateChat } from "../src/bot/auth.js";

describe("isAllowedUser", () => {
  it("allows configured users", () => {
    expect(isAllowedUser(123, new Set(["123"]))).toBe(true);
  });

  it("rejects missing or unconfigured users", () => {
    expect(isAllowedUser(undefined, new Set(["123"]))).toBe(false);
    expect(isAllowedUser(456, new Set(["123"]))).toBe(false);
  });
});

describe("isPrivateChat", () => {
  it("only allows direct chats", () => {
    expect(isPrivateChat("private")).toBe(true);
    expect(isPrivateChat("group")).toBe(false);
    expect(isPrivateChat("supergroup")).toBe(false);
    expect(isPrivateChat(undefined)).toBe(false);
  });
});
