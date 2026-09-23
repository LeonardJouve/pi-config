import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpawnQueue } from "../queue.ts";

/**
 * Test harness modelling index.ts: `start()` resolves once the pane is up and
 * the watcher is wired (not when the subagent finishes), and the subagent keeps
 * occupying a slot until the test calls finish().
 */
function harness(maxConcurrent: number) {
  let running = 0;
  const started: string[] = [];
  const failures: Array<{ name: string; message: string }> = [];
  const finishers = new Map<string, () => void>();

  const queue = createSpawnQueue({
    maxConcurrent,
    runningCount: () => running,
    onStartFailure: (item, error) =>
      failures.push({
        name: item.name,
        message: error instanceof Error ? error.message : String(error),
      }),
    onChange: () => {},
  });

  /** Mirrors the subagent tool: schedule a spawn that occupies a slot. */
  function spawn(name: string, opts: { fail?: boolean } = {}) {
    return queue.schedule({
      name,
      start: async () => {
        // launchSubagent is async (pane creation), so a slot only shows up in
        // runningCount() after an await — exactly the window the cap must cover.
        await Promise.resolve();
        started.push(name);
        // A failed launch never occupies a slot, like launchSubagent throwing
        // before it registers the RunningSubagent.
        if (opts.fail) throw new Error(`boom ${name}`);
        running++;
        finishers.set(name, () => {
          running--;
        });
        return name;
      },
    });
  }

  return {
    queue,
    spawn,
    started,
    failures,
    running: () => running,
    /** A started subagent exits, freeing its slot. */
    finish(name: string) {
      finishers.get(name)?.();
    },
  };
}

test("schedule starts immediately while slots are free", async () => {
  const h = harness(2);

  const a = await h.spawn("A");
  const b = await h.spawn("B");

  assert.deepEqual(a, { queued: false, value: "A" });
  assert.deepEqual(b, { queued: false, value: "B" });
  assert.deepEqual(h.started, ["A", "B"]);
  assert.equal(h.running(), 2);
  assert.equal(h.queue.pending().length, 0);
});

test("schedule queues once the cap is reached", async () => {
  const h = harness(2);
  await h.spawn("A");
  await h.spawn("B");

  const c = await h.spawn("C");
  const d = await h.spawn("D");

  assert.deepEqual(c, { queued: true, position: 1 });
  assert.deepEqual(d, { queued: true, position: 2 });
  assert.deepEqual(h.started, ["A", "B"]);
  assert.deepEqual(
    h.queue.pending().map((i) => i.name),
    ["C", "D"],
  );
});

test("sibling spawns in the same tick never exceed the cap", async () => {
  const h = harness(2);

  // Pi executes sibling tool calls from one assistant message concurrently.
  const outcomes = await Promise.all([
    h.spawn("A"),
    h.spawn("B"),
    h.spawn("C"),
    h.spawn("D"),
  ]);

  assert.deepEqual(
    outcomes.map((o) => o.queued),
    [false, false, true, true],
  );
  assert.deepEqual(h.started, ["A", "B"]);
  assert.equal(h.running(), 2);
  assert.equal(h.queue.pending().length, 2);
});

test("drain starts queued items in FIFO order as slots free", async () => {
  const h = harness(1);
  await h.spawn("A");
  await h.spawn("B");
  await h.spawn("C");
  assert.deepEqual(h.started, ["A"]);

  h.finish("A");
  await h.queue.drain(); // what the watcher calls when a subagent exits
  assert.deepEqual(h.started, ["A", "B"]);
  assert.equal(h.running(), 1);

  h.finish("B");
  await h.queue.drain();
  assert.deepEqual(h.started, ["A", "B", "C"]);
  assert.equal(h.queue.pending().length, 0);
});

test("one drain fills every free slot", async () => {
  const h = harness(3);
  await h.spawn("A");
  await Promise.all([h.spawn("B"), h.spawn("C"), h.spawn("D")]);
  assert.deepEqual(h.started, ["A", "B", "C"]);

  h.finish("A");
  h.finish("B");
  await h.queue.drain();

  assert.deepEqual(h.started, ["A", "B", "C", "D"]);
  assert.equal(h.running(), 2);
});

test("concurrent drains never exceed the cap", async () => {
  const h = harness(1);
  await h.spawn("A");
  await h.spawn("B");
  await h.spawn("C");

  h.finish("A");
  await Promise.all([h.queue.drain(), h.queue.drain(), h.queue.drain()]);

  assert.deepEqual(h.started, ["A", "B"]);
  assert.equal(h.running(), 1);
  assert.equal(h.queue.pending().length, 1);
});

test("a queued launch failure is reported and does not wedge the queue", async () => {
  const h = harness(1);
  await h.spawn("A");
  await h.spawn("B", { fail: true });
  await h.spawn("C");

  h.finish("A");
  await h.queue.drain();

  assert.deepEqual(h.failures, [{ name: "B", message: "boom B" }]);
  assert.deepEqual(h.started, ["A", "B", "C"]);
  assert.equal(h.running(), 1);
  assert.equal(h.queue.pending().length, 0);
});

test("an immediate launch failure rethrows and frees the slot", async () => {
  const h = harness(1);

  await assert.rejects(() => h.spawn("A", { fail: true }), /boom A/);

  assert.equal(h.running(), 0);
  assert.equal(h.queue.pending().length, 0);
  assert.deepEqual(await h.spawn("B"), { queued: false, value: "B" });
});

test("clear drops everything waiting", async () => {
  const h = harness(1);
  await h.spawn("A");
  await h.spawn("B");
  h.queue.clear();

  h.finish("A");
  await h.queue.drain();

  assert.deepEqual(h.started, ["A"]);
  assert.equal(h.queue.pending().length, 0);
});
