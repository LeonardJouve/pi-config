import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  WIDGET_ID,
  borderLine,
  borderBottom,
  borderTop,
  createWidgetController,
  renderSubagentWidgetLines,
} from "../widget.ts";

test("borderLine pads to exact width", () => {
  const line = borderLine(" left ", " right ", 30);
  assert.equal(visibleWidth(line), 30);
  assert.ok(line.includes("left"));
  assert.ok(line.includes("right"));
});

test("borderLine truncates left but preserves right", () => {
  const line = borderLine("a".repeat(100), " run ", 40);
  assert.equal(visibleWidth(line), 40);
  assert.ok(line.includes("run"));
});

test("borderLine truncates right when it does not fit", () => {
  const line = borderLine("left", "r".repeat(100), 20);
  assert.equal(visibleWidth(line), 20);
});

test("borderLine handles degenerate widths", () => {
  assert.equal(borderLine("a", "b", 0), "");
  assert.equal(visibleWidth(borderLine("a", "b", 1)), 1);
});

test("borderTop and borderBottom render at exact width", () => {
  const top = borderTop("Subagents", "2 running", 40);
  const bottom = borderBottom(40);
  assert.equal(visibleWidth(top), 40);
  assert.equal(visibleWidth(bottom), 40);
  assert.ok(top.includes("Subagents"));
  assert.ok(top.includes("2 running"));
  assert.equal(borderTop("a", "b", 0), "");
  assert.equal(visibleWidth(borderBottom(1)), 1);
});

test("borderTop pads when title+info exceed width", () => {
  const top = borderTop("A very long title", "and very long info", 10);
  assert.equal(visibleWidth(top), 10);
});

test("renderSubagentWidgetLines produces a bordered box", () => {
  const now = Date.now();
  const lines = renderSubagentWidgetLines(
    [
      { name: "Scout: Auth", agent: "scout", startTime: now - 23_000 },
      { name: "Worker", startTime: now - 65_000 },
    ],
    50,
  );
  assert.equal(lines.length, 4); // top + 2 agents + bottom
  for (const line of lines) assert.equal(visibleWidth(line), 50);
  assert.ok(lines[0].includes("2 running"));
  assert.ok(lines[1].includes("00:23"));
  assert.ok(lines[1].includes("(scout)"));
  assert.ok(lines[2].includes("01:05"));
});

test("widget controller sets and clears the widget", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"], now: 0 });

  const calls: Array<unknown> = [];
  let agents: Array<{ name: string; startTime: number }> = [];

  const controller = createWidgetController({
    getAgents: () => agents,
    setWidget: (_id, factory) => calls.push(factory),
  });

  // No agents → widget cleared (undefined)
  controller.refresh();
  assert.deepEqual(calls, [undefined]);

  // With agents → widget factory set, rendering live agent list
  agents = [{ name: "A", startTime: Date.now() }];
  controller.refresh();
  assert.equal(calls.length, 2);
  const factory = calls[1] as unknown as (tui: unknown, theme: unknown) => { render(w: number): string[] };
  const rendered = factory(null, null).render(40);
  assert.equal(rendered.length, 3);
  assert.ok(rendered[1].includes("A"));

  // start() renders immediately and ticks on the interval
  calls.length = 0;
  controller.start();
  controller.start(); // idempotent — single interval
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1000);
  assert.equal(calls.length, 2);

  // stop() ends ticking
  controller.stop();
  controller.stop(); // idempotent
  t.mock.timers.tick(5000);
  assert.equal(calls.length, 2);
});

test("widget controller renders live agent changes without refresh", () => {
  let agents: Array<{ name: string; startTime: number }> = [{ name: "A", startTime: Date.now() }];
  let lastFactory: any = null;
  const controller = createWidgetController({
    getAgents: () => agents,
    setWidget: (_id, factory) => {
      lastFactory = factory;
    },
  });
  controller.refresh();
  agents = [
    { name: "A", startTime: Date.now() },
    { name: "B", startTime: Date.now() },
  ];
  const lines = lastFactory(null, null).render(60);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].includes("2 running"));
  assert.equal(WIDGET_ID, "subagent-status");
});
