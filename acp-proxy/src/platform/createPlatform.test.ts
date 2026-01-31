import { describe, expect, it } from "vitest";

import { createPlatform } from "./createPlatform.js";
import { BoxlitePlatform } from "./boxlite/boxlitePlatform.js";
import { ContainerPlatform } from "./container/containerPlatform.js";
import { NativePlatform } from "./native/nativePlatform.js";

describe("createPlatform", () => {
  it("createPlatform selects implementation by provider", () => {
    expect(createPlatform({ sandbox: { provider: "host_process" } })).toBeInstanceOf(NativePlatform);
    expect(createPlatform({ sandbox: { provider: "container_oci" } })).toBeInstanceOf(ContainerPlatform);
    expect(createPlatform({ sandbox: { provider: "boxlite_oci" } })).toBeInstanceOf(BoxlitePlatform);
  });
});

