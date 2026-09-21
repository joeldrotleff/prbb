import { describe, expect, test } from "bun:test";
import { parsePrInput, prKey } from "../src/core/ref.ts";
import { PrbbError } from "../src/util/errors.ts";

describe("parsePrInput", () => {
  test("parses org/number with repo left unresolved", () => {
    expect(parsePrInput("new-quest-ai/1691")).toEqual({ owner: "new-quest-ai", number: 1691 });
  });

  test("parses owner/repo#number", () => {
    expect(parsePrInput("acme/widgets#7")).toEqual({ owner: "acme", repo: "widgets", number: 7 });
  });

  test("parses a full PR URL, including trailing path or query", () => {
    expect(parsePrInput("https://github.com/acme/widgets/pull/42")).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 42,
    });
    expect(parsePrInput("https://github.com/acme/widgets/pull/42/files?diff=split").number).toBe(
      42,
    );
  });

  test("garbage input fails with usage code", () => {
    try {
      parsePrInput("not a ref");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PrbbError);
      expect((error as PrbbError).code).toBe("usage");
    }
  });

  test("prKey formats owner/repo#number", () => {
    expect(prKey({ owner: "a", repo: "b", number: 3 })).toBe("a/b#3");
  });
});
