import assert from "node:assert/strict";
import { test } from "node:test";

import { assertDomainTabLimits, domainMatches, hostOf, rulesToCheck } from "./tablimit.js";

test("hostOf lowercases hosts and ignores invalid URLs", () => {
  assert.equal(hostOf("https://WWW.Example.com/path"), "www.example.com");
  assert.equal(hostOf("not a url"), "");
});

test("domainMatches requires a label boundary", () => {
  assert.equal(domainMatches("www.example.com", "example.com"), true);
  assert.equal(domainMatches("badexample.com", "example.com"), false);
});

test("rulesToCheck uses the most specific target rule", () => {
  const rules = [
    { domain: "example.com", max: 1 },
    { domain: "api.example.com", max: 2 },
  ];
  assert.deepEqual(rulesToCheck(rules, "https://api.example.com/v1"), [{ domain: "api.example.com", max: 2 }]);
});

test("rulesToCheck ignores domain whitespace when choosing specificity", () => {
  const rules = [
    { domain: "example.com                         ", max: 1 },
    { domain: "api.example.com", max: 2 },
  ];
  assert.deepEqual(rulesToCheck(rules, "https://api.example.com/v1"), [{ domain: "api.example.com", max: 2 }]);
});

test("assertDomainTabLimits rejects when matching tabs reach max", () => {
  assert.throws(
    () =>
      assertDomainTabLimits([{ domain: "example.com", max: 2 }], "https://www.example.com/new", [
        "https://example.com/a",
        "https://www.example.com/b",
      ]),
    /per-domain tab limit reached/
  );
});

test("assertDomainTabLimits ignores non-target domains", () => {
  assert.doesNotThrow(() =>
    assertDomainTabLimits([{ domain: "example.com", max: 1 }], "https://other.test/new", ["https://example.com/a"])
  );
});
