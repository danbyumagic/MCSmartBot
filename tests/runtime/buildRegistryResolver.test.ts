import { describe, expect, it } from "vitest";
import { createConfiguredBuildRegistryResolver } from "../../src/runtime/connection.js";

describe("configured BuildOps registry resolver", () => {
  it("resolves the selected installed version exactly and rejects other source targets", () => {
    const resolver = createConfiguredBuildRegistryResolver("1.21.11");
    expect(resolver("1.21.10")).toBeUndefined();
    expect(resolver("1.20.4")).toBeUndefined();
    expect(resolver("1.21.11")).toMatchObject({ version: "1.21.11" });
  });

  it("does not silently accept minecraft-data's neighboring-version fallback", () => {
    // minecraft-data currently resolves this unavailable patch target to 1.21.9.
    // The resolver must fail closed rather than substituting the nearby registry.
    const resolver = createConfiguredBuildRegistryResolver("1.21.10");
    expect(resolver("1.21.10")).toBeUndefined();
  });
});
