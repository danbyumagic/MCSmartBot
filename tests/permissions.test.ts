import { describe, it, expect } from "vitest";
import { isOwner, requireOwner, NotOwnerError, refusalMessage } from "../src/permissions/index.js";

describe("permissions", () => {
  it("isOwner follows Minecraft's case-insensitive username semantics", () => {
    expect(isOwner("alice", "alice")).toBe(true);
    expect(isOwner("Alice", "alice")).toBe(true);
    expect(isOwner("", "alice")).toBe(false);
  });

  it("requireOwner throws NotOwnerError for non-owners", () => {
    expect(() => requireOwner("bob", "alice")).toThrow(NotOwnerError);
  });

  it("requireOwner returns void for the owner", () => {
    expect(requireOwner("alice", "alice")).toBeUndefined();
  });

  it("refusalMessage names the owner", () => {
    expect(refusalMessage("alice")).toBe("Sorry, I only take orders from alice.");
  });
});
