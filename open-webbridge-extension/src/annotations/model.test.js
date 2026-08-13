import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_SHOTS,
  clampWait,
  filterAnnotations,
  makeRecord,
  pruneItems,
  sanitizeElement,
  shotIdsToKeep,
  stats,
  toWire,
  urlKey,
} from "./model.js";

const baseInput = {
  comment: "  this button does nothing  ",
  tags: ["bug", "bug", "  layout  ", ""],
  url: "https://example.com/app?tab=1#section",
  title: "App",
  top_frame: true,
  element: {
    tag: "BUTTON",
    name: "Submit",
    selector: "#submit",
    selectors: { css: "form > button", xpath: "/html[1]/body[1]", testid: "", aria: "" },
    rect: { x: 10.123, y: 20.987, w: 100, h: 30 },
  },
  viewport: { w: 1280, h: 800, dpr: 2 },
};

function record(seq, over = {}) {
  return makeRecord({ seq, input: { ...baseInput, ...over }, tabId: 7, session: "work", now: 0 });
}

test("urlKey drops the fragment but keeps the query", () => {
  assert.equal(urlKey("https://example.com/a?b=1#frag"), "https://example.com/a?b=1");
  assert.equal(urlKey("not a url"), "not a url");
});

test("makeRecord normalises the submission", () => {
  const r = record(3);
  assert.equal(r.id, "a3");
  assert.equal(r.comment, "this button does nothing");
  assert.deepEqual(r.tags, ["bug", "layout"]);
  assert.equal(r.status, "open");
  assert.equal(r.url_key, "https://example.com/app?tab=1");
  assert.equal(r.element.tag, "button");
  assert.equal(r.tabId, 7);
  assert.equal(r.session, "work");
  assert.equal(r.has_screenshot, false);
});

test("makeRecord keeps the frame url only for sub-frames", () => {
  assert.equal(record(1).frame_url, "");
  const sub = makeRecord({
    seq: 2,
    input: { ...baseInput, top_frame: false, frame_url: "https://cdn.example.com/widget" },
    tabId: 1,
    now: 0,
  });
  assert.equal(sub.frame_url, "https://cdn.example.com/widget");
  assert.equal(sub.top_frame, false);
});

test("sanitizeElement bounds untrusted page strings", () => {
  const el = sanitizeElement({
    tag: "DIV",
    name: "x".repeat(500),
    attrs: { href: "y".repeat(500), "": "dropped" },
    ancestors: new Array(20).fill("main"),
  });
  assert.equal(el.name.length, 200);
  assert.equal(el.attrs.href.length, 200);
  assert.equal(el.ancestors.length, 6);
  assert.equal(el.attrs[""], undefined);
});

test("filterAnnotations defaults to open notes and honours since", () => {
  const items = [record(1), record(2), record(3)];
  items[1].status = "resolved";
  assert.deepEqual(filterAnnotations(items).map((i) => i.id), ["a1", "a3"]);
  assert.deepEqual(filterAnnotations(items, { status: "all" }).map((i) => i.id), ["a1", "a2", "a3"]);
  assert.deepEqual(filterAnnotations(items, { status: "resolved" }).map((i) => i.id), ["a2"]);
  assert.deepEqual(filterAnnotations(items, { since: 1 }).map((i) => i.id), ["a3"]);
  assert.deepEqual(filterAnnotations(items, { since: "1" }).map((i) => i.id), ["a3"]);
});

test("filterAnnotations matches url substrings, tags, ids and tabs", () => {
  const items = [record(1), record(2, { url: "https://other.test/page" })];
  assert.deepEqual(filterAnnotations(items, { url: "other.test" }).map((i) => i.id), ["a2"]);
  assert.deepEqual(filterAnnotations(items, { url: "OTHER.TEST" }).map((i) => i.id), ["a2"]);
  assert.deepEqual(filterAnnotations(items, { ids: ["a1"] }).map((i) => i.id), ["a1"]);
  assert.deepEqual(filterAnnotations(items, { tag: "LAYOUT" }).map((i) => i.id), ["a1", "a2"]);
  assert.deepEqual(filterAnnotations(items, { tabId: 99 }), []);
});

test("filterAnnotations limit keeps the newest and preserves order", () => {
  const items = [record(1), record(2), record(3)];
  assert.deepEqual(filterAnnotations(items, { limit: 2 }).map((i) => i.id), ["a2", "a3"]);
});

test("toWire stays compact by default and expands on demand", () => {
  const r = record(1);
  r.note = "fixed in commit abc";
  const compact = toWire(r);
  assert.equal(compact.element.selector, "#submit");
  assert.equal(compact.element.selectors, undefined);
  assert.equal(compact.note, "fixed in commit abc");
  const verbose = toWire(r, { verbose: true });
  assert.equal(verbose.element.selectors.css, "form > button");
  assert.equal(verbose.url_key, "https://example.com/app?tab=1");
});

test("pruneItems keeps the newest records", () => {
  const items = [record(1), record(2), record(3)];
  assert.deepEqual(pruneItems(items, 2).map((i) => i.id), ["a2", "a3"]);
});

test("shotIdsToKeep drops the oldest images and orphans", () => {
  const items = [record(1), record(2), record(3)];
  const keep = shotIdsToKeep(items, ["a1", "a2", "a3", "gone"], 2);
  assert.deepEqual([...keep].sort(), ["a2", "a3"]);
  assert.ok(MAX_SHOTS > 0);
});

test("stats counts open, resolved and pages", () => {
  const items = [record(1), record(2, { url: "https://other.test/x" })];
  items[0].status = "resolved";
  items[1].has_screenshot = true;
  const s = stats(items);
  assert.equal(s.total, 2);
  assert.equal(s.open, 1);
  assert.equal(s.resolved, 1);
  assert.equal(s.with_screenshot, 1);
  assert.equal(s.pages.length, 2);
});

test("clampWait bounds long polls", () => {
  assert.equal(clampWait(undefined), 0);
  assert.equal(clampWait(0), 0);
  assert.equal(clampWait(-5), 0);
  assert.equal(clampWait(10), 250);
  assert.equal(clampWait(5000), 5000);
  assert.equal(clampWait(9e9), 240000);
});
