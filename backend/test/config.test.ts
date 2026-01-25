import { describe, expect, it } from "vitest";

import { loadEnv } from "../src/config.js";

describe("loadEnv", () => {
  it("throws when DATABASE_URL is missing", () => {
    const prevDb = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    expect(() => loadEnv()).toThrow();
    if (prevDb !== undefined) process.env.DATABASE_URL = prevDb;
  });

  it("parses PORT and applies defaults", () => {
    const prevDb = process.env.DATABASE_URL;
    const prevPort = process.env.PORT;
    const prevHost = process.env.HOST;
    process.env.DATABASE_URL = "postgresql://example";
    process.env.PORT = "4567";
    delete process.env.HOST;

    const env = loadEnv();
    expect(env.PORT).toBe(4567);
    expect(env.HOST).toBe("0.0.0.0");

    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
    if (prevPort === undefined) delete process.env.PORT;
    else process.env.PORT = prevPort;
    if (prevHost === undefined) delete process.env.HOST;
    else process.env.HOST = prevHost;
  });
});
