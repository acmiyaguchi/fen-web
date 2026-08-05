import { test } from "node:test";
import assert from "node:assert/strict";

import { FakeDom } from "./fakeDom.js";
import { normalizeOps } from "./applyOps.js";
import type { DomEvent } from "./types.js";

test("create attaches under parent and sets text/class in one op", () => {
  const dom = new FakeDom("root");
  dom.apply([{ op: "create", id: "r1", parent: "root", tag: "div", text: "hello", class: "row" }]);
  assert.deepEqual(dom.childIds("root"), ["r1"]);
  assert.equal(dom.get("r1").text, "hello");
  assert.equal(dom.get("r1").className, "row");
});

test("create is idempotent but still re-applies text/class (reload survives)", () => {
  const dom = new FakeDom("root");
  dom.apply([{ op: "create", id: "r1", parent: "root", tag: "div", text: "a" }]);
  dom.apply([{ op: "create", id: "r1", parent: "root", tag: "div", text: "b" }]);
  assert.deepEqual(dom.childIds("root"), ["r1"]);
  assert.equal(dom.get("r1").text, "b");
});

test("create with before inserts ahead of an existing sibling", () => {
  const dom = new FakeDom("root");
  dom.apply([
    { op: "create", id: "b", parent: "root", tag: "div" },
    { op: "create", id: "a", parent: "root", tag: "div", before: "b" },
  ]);
  assert.deepEqual(dom.childIds("root"), ["a", "b"]);
});

test("text/class update in place; remove drops the subtree", () => {
  const dom = new FakeDom("root");
  dom.apply([
    { op: "create", id: "p", parent: "root", tag: "div" },
    { op: "create", id: "c", parent: "p", tag: "span" },
  ]);
  dom.apply([
    { op: "text", id: "c", text: "x" },
    { op: "class", id: "c", class: "k" },
  ]);
  assert.equal(dom.get("c").text, "x");
  assert.equal(dom.get("c").className, "k");
  dom.apply([{ op: "remove", id: "p" }]);
  assert.equal(dom.exists("p"), false);
  assert.equal(dom.exists("c"), false);
  assert.deepEqual(dom.childIds("root"), []);
});

test("attr sets and (nil value) removes; prop/get round-trip", () => {
  const dom = new FakeDom("root");
  dom.apply([{ op: "create", id: "in", parent: "root", tag: "input" }]);
  dom.apply([{ op: "attr", id: "in", name: "placeholder", value: "type here" }]);
  assert.equal(dom.get("in").attrs.get("placeholder"), "type here");
  dom.apply([{ op: "attr", id: "in", name: "placeholder" }]);
  assert.equal(dom.get("in").attrs.has("placeholder"), false);

  dom.apply([{ op: "prop", id: "in", name: "value", value: "typed" }]);
  const results = dom.apply([{ op: "get", id: "in", name: "value" }]);
  assert.equal(results[0], "typed");
});

test("get on an unset value returns '' (never a truncating nil)", () => {
  const dom = new FakeDom("root");
  dom.apply([{ op: "create", id: "in", parent: "root", tag: "input" }]);
  const results = dom.apply([{ op: "get", id: "in", name: "value" }, { op: "exists", id: "nope" }]);
  assert.equal(results[0], "");
  assert.equal(results[1], false);
});

test("listen enqueues events drained by drain-events, in order, then clears", () => {
  const dom = new FakeDom("root");
  dom.apply([
    { op: "create", id: "form", parent: "root", tag: "form" },
    { op: "listen", id: "form", event: "submit" },
  ]);
  dom.emit("form", "submit", "hi");
  dom.emit("form", "submit", "there");
  const first = dom.apply([{ op: "drain-events" }])[0] as DomEvent[];
  assert.deepEqual(first, [
    { id: "form", event: "submit", value: "hi" },
    { id: "form", event: "submit", value: "there" },
  ]);
  const second = dom.apply([{ op: "drain-events" }])[0] as DomEvent[];
  assert.deepEqual(second, []);
});

test("emit without a matching listener is ignored", () => {
  const dom = new FakeDom("root");
  dom.apply([{ op: "create", id: "form", parent: "root", tag: "form" }]);
  dom.emit("form", "submit", "x");
  assert.deepEqual(dom.apply([{ op: "drain-events" }])[0], []);
});

test("mutating a missing element throws (catches presenter model drift)", () => {
  const dom = new FakeDom("root");
  assert.throws(() => dom.apply([{ op: "text", id: "ghost", text: "x" }]), /missing element 'ghost'/);
});

test("unknown op throws", () => {
  const dom = new FakeDom("root");
  // deliberately bypass the union type to exercise the runtime guard
  assert.throws(() => dom.apply([{ op: "wat" } as never]), /unknown op 'wat'/);
});

test("normalizeOps accepts arrays and Lua-style 1-based objects", () => {
  const arr = [{ op: "remove", id: "a" }, { op: "remove", id: "b" }];
  assert.deepEqual(normalizeOps(arr), arr);
  const luaish = { 1: { op: "remove", id: "a" }, 2: { op: "remove", id: "b" } };
  assert.deepEqual(normalizeOps(luaish), arr);
  assert.deepEqual(normalizeOps(undefined), []);
});
