import { describe, expect, test } from "bun:test";
import { nextPollDelay } from "../src/core/backoff.ts";

describe("nextPollDelay", () => {
  const options = { baseMs: 1000, maxMs: 8000 };

  test("healthy polling uses the base interval", () => {
    expect(nextPollDelay(0, options)).toBe(1000);
  });

  test("doubles per consecutive failure", () => {
    expect(nextPollDelay(1, options)).toBe(2000);
    expect(nextPollDelay(2, options)).toBe(4000);
  });

  test("caps at maxMs", () => {
    expect(nextPollDelay(10, options)).toBe(8000);
  });
});
