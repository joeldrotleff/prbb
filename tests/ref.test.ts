import { describe, expect, test } from "bun:test";
import { parsePrRef, prKey } from "../src/core/ref.ts";
import { PrbbError } from "../src/util/errors.ts";

describe("parsePrRef", () => {
  test("parses a full PR URL", () => {
    expect(parsePrRef("https://github.com/acme/widgets/pull/42")).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 42,
    });
  });

  test("parses a URL with trailing path or query", () => {
    expect(parsePrRef("https://github.com/acme/widgets/pull/42/files?diff=split").number).toBe(42);
  });

  test("parses owner/repo#number shorthand", () => {
    expect(parsePrRef("acme/widgets#7")).toEqual({ owner: "acme", repo: "widgets", number: 7 });
  });

  test("parses a bare number with a context repo", () => {
    expect(parsePrRef("42", "acme/widgets")).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 42,
    });
    expect(parsePrRef("#42", "acme/widgets").number).toBe(42);
  });

  test("bare number without context fails with usage code", () => {
    try {
      parsePrRef("42");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PrbbError);
      expect((error as PrbbError).code).toBe("usage");
      expect((error as PrbbError).message).toContain("ambiguous");
    }
  });

  test("garbage input fails with usage code", () => {
    expect(() => parsePrRef("not-a-ref")).toThrow(PrbbError);
  });

  test("prKey formats owner/repo#number", () => {
    expect(prKey({ owner: "a", repo: "b", number: 3 })).toBe("a/b#3");
  });
});
