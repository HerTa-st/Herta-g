import { describe, expect, it } from "vitest";
import type {
  ActorPromptFrame,
  BackendPromptFrame,
  PromptFrame,
} from "./prompt.js";

describe("prompt frame types", () => {
  it("ActorPromptFrame is the existing PromptFrame shape", () => {
    const actor: ActorPromptFrame = {
      stableSystem: "",
      memoryContext: "",
      retrievedLore: "",
      messages: [],
      toolSchemas: [],
    };
    // Round-trip: an ActorPromptFrame is structurally a PromptFrame.
    const asLegacy: PromptFrame = actor;
    expect(asLegacy.stableSystem).toBe("");
  });

  it("BackendPromptFrame has the prescribed fields and no actor-only fields", () => {
    const backend: BackendPromptFrame = {
      backendSystem: "",
      scopedMemory: "",
      toolSchemas: [],
      messages: [],
    };
    expect(backend.backendSystem).toBe("");

    // Compile-time guards: confirm BackendPromptFrame omits the actor-only
    // fields. A future contributor adding `stableSystem` or `retrievedLore`
    // to BackendPromptFrame breaks these assignments at compile time.
    type HasStableSystem = "stableSystem" extends keyof BackendPromptFrame
      ? true
      : false;
    const noStableSystem: HasStableSystem = false;
    expect(noStableSystem).toBe(false);

    type HasRetrievedLore = "retrievedLore" extends keyof BackendPromptFrame
      ? true
      : false;
    const noLore: HasRetrievedLore = false;
    expect(noLore).toBe(false);
  });
});
