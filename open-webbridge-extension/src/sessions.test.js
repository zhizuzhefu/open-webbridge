import assert from "node:assert/strict";
import { test } from "node:test";

function installChromeMock({ removeFailures = new Set() } = {}) {
  const storage = { owb_owned_groups: { 42: "custom-session" } };
  const groups = new Map([[42, { id: 42, title: "Renamed Group" }]]);
  const tabs = new Map([[7, { id: 7, url: "https://example.com/a", title: "A", groupId: 42 }]]);
  const created = [];
  let nextTabId = 100;

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, storage[k]]));
          return { [key]: storage[key] };
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
    },
    tabGroups: {
      async query() {
        return [...groups.values()];
      },
      async update(groupId, updates) {
        const g = groups.get(groupId);
        if (!g) throw new Error("missing group");
        Object.assign(g, updates);
        return g;
      },
    },
    tabs: {
      async query(query) {
        if (query && query.groupId != null) return [...tabs.values()].filter((t) => t.groupId === query.groupId);
        return [...tabs.values()];
      },
      async get(tabId) {
        const tab = tabs.get(tabId);
        if (!tab) throw new Error("missing tab");
        return tab;
      },
      async create(props) {
        const tab = {
          id: nextTabId++,
          url: props.url || "",
          pendingUrl: props.url || "",
          title: "",
          groupId: -1,
        };
        tabs.set(tab.id, tab);
        created.push(tab);
        return tab;
      },
      async group({ tabIds, groupId }) {
        const gid = groupId != null ? groupId : 42;
        if (!groups.has(gid)) groups.set(gid, { id: gid, title: "" });
        for (const id of tabIds) {
          const tab = tabs.get(id);
          if (tab) tab.groupId = gid;
        }
        return gid;
      },
      async remove(tabId) {
        if (removeFailures.has(tabId)) throw new Error("remove failed");
        if (!tabs.has(tabId)) throw new Error("missing tab");
        tabs.delete(tabId);
      },
    },
    debugger: {
      onDetach: { addListener() {} },
      sendCommand() {},
      attach() {},
      detach() {},
      getTargets(callback) {
        callback([]);
      },
    },
    runtime: { lastError: null },
  };
  return { storage, tabs, created };
}

test("reconcile recovers a renamed group by persisted ownership", async () => {
  installChromeMock();
  const mod = await import(`./sessions.js?ownership=${Date.now()}-${Math.random()}`);

  const session = await mod.reconcile("custom-session");
  assert.equal(session.groupId, 42);
  assert.deepEqual([...session.tabIds], [7]);

  const tracked = await mod.trackedGroupIds();
  assert.equal(tracked.has(42), true);
});

test("closeSession keeps ownership when a live tab fails to close", async () => {
  const mock = installChromeMock({ removeFailures: new Set([7]) });
  const mod = await import(`./sessions.js?close-failure=${Date.now()}-${Math.random()}`);

  const closed = await mod.closeSession("custom-session");

  assert.equal(closed, 0);
  assert.deepEqual(mock.storage.owb_owned_groups, { 42: "custom-session" });
  assert.equal(mock.tabs.has(7), true);

  const tracked = await mod.trackedGroupIds();
  assert.equal(tracked.has(42), true);
});

test("closeGroup keeps ownership when a live tab fails to close", async () => {
  const mock = installChromeMock({ removeFailures: new Set([7]) });
  const mod = await import(`./sessions.js?group-close-failure=${Date.now()}-${Math.random()}`);

  const closed = await mod.closeGroup(42);

  assert.equal(closed, 0);
  assert.deepEqual(mock.storage.owb_owned_groups, { 42: "custom-session" });
  assert.equal(mock.tabs.has(7), true);
});

test("newTab replacement aborts when the old tab cannot close", async () => {
  const mock = installChromeMock({ removeFailures: new Set([7]) });
  const mod = await import(`./sessions.js?replace-failure=${Date.now()}-${Math.random()}`);

  await assert.rejects(
    () =>
      mod.acquireTabForNavigation("custom-session", {
        newTab: true,
        targetUrl: "https://example.com/new",
        domainTabLimits: [{ domain: "example.com", max: 1 }],
      }),
    /could not close existing session tab/
  );
  assert.equal(mock.created.length, 0);
  assert.equal(mock.tabs.has(7), true);
});
