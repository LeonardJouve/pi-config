const reg = {};
const mod = await import("./index.ts");
mod.default({ registerTool: (d) => Object.assign(reg, d) });

console.log("tool:", reg.name, "| params:", JSON.stringify(Object.keys(reg.parameters.properties ?? {})));

const base = {
  state: "The agent fixed the checkout bug, tests pass, and the PR has a clear description.",
  questions: [
    { id: "done", type: "boolean", instructions: "Is the task complete?" },
    { id: "route", type: "choice", instructions: "Which team owns this?", criteria: { frontend: "ui", backend: "server", infra: "deploy" } },
    { id: "quality", type: "score", instructions: "Rate quality", criteria: ["poor", "fair", "good", "excellent"] },
  ],
};

console.log("--- validation path (score with bad criteria) ---");
try {
  await reg.execute("t", { state: "x", questions: [{ id: "q", type: "score", instructions: "i", criteria: ["only"] }] }, undefined, undefined, {});
  console.log("UNEXPECTED OK");
} catch (e) { console.log("ERR(expected):", e.message); }

console.log("--- auth path (no key) ---");
const savedKey = process.env.VERCEL_AI_API_KEY;
delete process.env.VERCEL_AI_API_KEY;
try {
  await reg.execute("t", base, undefined, undefined, {});
  console.log("UNEXPECTED OK");
} catch (e) { console.log("ERR(expected):", e.message); }
if (savedKey) process.env.VERCEL_AI_API_KEY = savedKey;

if (process.env.VERCEL_AI_API_KEY) {
  console.log("--- live call ---");
  const r = await reg.execute("t", base, undefined, undefined, {});
  console.log(r.content[0].text);
  console.log("usage:", JSON.stringify(r.usage));
}
