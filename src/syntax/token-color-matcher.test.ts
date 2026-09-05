import assert from "node:assert/strict";
import { test } from "node:test";

import { createTokenColorMatcher } from "./token-color-matcher.ts";

// Run with: node --test src/token-color-matcher.test.ts

test("a deeper scope beats a rule that names a parent scope", () => {
  const matcher = createTokenColorMatcher([
    { scope: "meta.block entity", settings: { foreground: "#ff0000" } },
    { scope: "entity.name.function", settings: { foreground: "#0000ff" } },
  ]);

  const match = matcher.matchScopeStack(["source.ts", "meta.block", "entity.name.function"]);

  assert.equal(match.foreground, "#0000ff");
  assert.equal(match.foregroundRuleIndex, 1);
});

test("a prefix only matches on a dot boundary", () => {
  const matcher = createTokenColorMatcher([
    { scope: "entity.name", settings: { foreground: "#00ff00" } },
    { scope: "entity.name.func", settings: { foreground: "#ff0000" } },
  ]);

  const match = matcher.matchScopeStack(["entity.name.function"]);

  assert.equal(match.foreground, "#00ff00");
  assert.equal(match.foregroundRuleIndex, 0);
});

test("a later rule that sets only a font style keeps the earlier foreground", () => {
  const matcher = createTokenColorMatcher([
    { scope: "entity.name.function", settings: { foreground: "#ff0000" } },
    { scope: "entity.name.function", settings: { fontStyle: "bold" } },
  ]);

  const match = matcher.matchScopeStack(["entity.name.function"]);

  assert.deepEqual(match, {
    foreground: "#ff0000",
    foregroundRuleIndex: 0,
    fontStyle: "bold",
    fontStyleRuleIndex: 1,
  });
});

test("the longer parent scope wins", () => {
  const matcher = createTokenColorMatcher([
    { scope: "meta entity", settings: { foreground: "#ff0000" } },
    { scope: "meta.block entity", settings: { foreground: "#0000ff" } },
  ]);

  const match = matcher.matchScopeStack(["meta.block", "entity"]);

  assert.equal(match.foreground, "#0000ff");
  assert.equal(match.foregroundRuleIndex, 1);
});

test("an empty font style turns bold off and keeps the foreground", () => {
  const matcher = createTokenColorMatcher([
    { scope: "keyword", settings: { foreground: "#ff0000", fontStyle: "bold" } },
    { scope: "keyword.control", settings: { fontStyle: "" } },
  ]);

  const match = matcher.matchScopeStack(["keyword.control"]);

  assert.deepEqual(match, {
    foreground: "#ff0000",
    foregroundRuleIndex: 0,
    fontStyle: "",
    fontStyleRuleIndex: 1,
  });
});

test("a token nothing matches falls back to the editor foreground", () => {
  const matcher = createTokenColorMatcher([{ scope: "keyword", settings: { foreground: "#ff0000" } }], "#cccccc");

  const match = matcher.matchScopeStack(["source.ts", "variable.other"]);

  assert.deepEqual(match, {
    foreground: "#cccccc",
    foregroundRuleIndex: null,
    fontStyle: null,
    fontStyleRuleIndex: null,
  });
});
