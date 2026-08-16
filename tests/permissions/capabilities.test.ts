import { describe, expect, it } from "vitest";
import {
  cloneCapabilityPolicy,
  createCapabilityPolicy,
  roleSatisfies,
} from "../../src/permissions/capabilities.js";

const viewerRead = createCapabilityPolicy({
  minimumRole: "viewer",
  effect: "read",
  reversible: false,
  mission: "public",
});

const operatorMutation = createCapabilityPolicy({
  minimumRole: "operator",
  effect: "world-change",
  reversible: true,
  mission: "public",
});

const ownerDestructive = createCapabilityPolicy({
  minimumRole: "owner",
  effect: "destructive",
  reversible: true,
  mission: "public",
});

describe("capability policy", () => {
  it("uses the explicit role ranking", () => {
    expect(roleSatisfies("viewer", viewerRead)).toBe(true);
    expect(roleSatisfies("viewer", operatorMutation)).toBe(false);
    expect(roleSatisfies("viewer", ownerDestructive)).toBe(false);
    expect(roleSatisfies("operator", viewerRead)).toBe(true);
    expect(roleSatisfies("operator", operatorMutation)).toBe(true);
    expect(roleSatisfies("operator", ownerDestructive)).toBe(false);
    expect(roleSatisfies("owner", viewerRead)).toBe(true);
    expect(roleSatisfies("owner", operatorMutation)).toBe(true);
    expect(roleSatisfies("owner", ownerDestructive)).toBe(true);
  });

  it("freezes policy snapshots rather than retaining caller-owned objects", () => {
    const mutable = {
      minimumRole: "operator" as const,
      effect: "inventory" as const,
      reversible: false,
      mission: "forbidden" as const,
    };
    const policy = createCapabilityPolicy(mutable);
    mutable.minimumRole = "owner";

    expect(policy.minimumRole).toBe("operator");
    expect(Object.isFrozen(policy)).toBe(true);

    const copy = cloneCapabilityPolicy(policy);
    expect(copy).toEqual(policy);
    expect(copy).not.toBe(policy);
    expect(Object.isFrozen(copy)).toBe(true);
  });

  it("rejects missing or malformed metadata at dynamic registration boundaries", () => {
    expect(() => cloneCapabilityPolicy(undefined as never)).toThrow(/required/);
    expect(() => cloneCapabilityPolicy({
      minimumRole: "operator",
      effect: "unsafe",
      reversible: false,
      mission: "public",
    } as never)).toThrow(/invalid/);
  });
});
