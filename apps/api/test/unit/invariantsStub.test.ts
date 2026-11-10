import { describe, it, expect } from "vitest";
import { assertGlobalInvariants } from "../../src/domain/invariants.js";

describe("assertGlobalInvariants (P4.6 stub)", () => {
  it("must not be silently a no-op — throws until Phase 6 wires the checks", async () => {
    await expect(assertGlobalInvariants({} as never)).rejects.toThrow(/Phase 6/);
  });
});
