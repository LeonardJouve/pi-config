/**
 * pi-jev — quick typed decisions via TypeSafe AI's Jev "System One" evaluation model.
 *
 * Exposes one tool, `jev`: give it shared state plus typed questions, it returns
 * choices, scores, and probabilities instead of a prose guess.
 *
 * Uses the Vercel AI SDK (`ai` + `@ai-sdk/gateway`).
 * Env: VERCEL_AI_API_KEY (AI Gateway key), optional JEV_MODEL.
 */

import { createGateway } from "@ai-sdk/gateway";
import { experimental_evaluate as evaluate, type Experimental_EvaluationQuestion as EvaluationQuestion } from "ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

type Kind = "boolean" | "choice" | "score";

interface QuestionInput {
  id: string;
  type: Kind;
  instructions: string;
  criteria?: unknown;
}

interface Answer {
  type: Kind;
  probability?: number;
  choice?: string;
  score?: number;
  probabilities?: Record<string, number>;
}

function fmtP(n: number | undefined): string {
  return typeof n === "number" ? n.toFixed(2) : "?";
}

const conf = (p: number) => (p >= 0.8 ? "HIGH" : p >= 0.6 ? "MED" : "LOW");

/** One tagged line per answer for the model; raw probabilities also kept in details for the TUI. */
function formatAnswer(q: QuestionInput, answer: Answer | undefined): string {
  if (!answer) return `${q.id}: NO_ANSWER the model omitted this question — treat as unverified, gather evidence`;
  if (answer.type === "boolean") {
    const p = answer.probability ?? 0;
    return `${q.id}: BOOLEAN=${p >= 0.5 ? "true" : "false"} P=${fmtP(p)} CONF=${conf(p)}`;
  }
  if (answer.type === "choice") {
    const entries = Object.entries(answer.probabilities ?? {});
    const best = entries.length ? Math.max(...entries.map(([, v]) => v)) : 0;
    const probs = entries.map(([k, v]) => `${k}=${fmtP(v)}`).join(" ");
    return `${q.id}: CHOICE=${answer.choice ?? "?"} P=${fmtP(best)} CONF=${conf(best)} ALL[${probs}]`;
  }
  const rungs = Array.isArray(q.criteria) ? (q.criteria as string[]) : [];
  const idx = Math.round(answer.score ?? 0);
  const entries = Object.entries(answer.probabilities ?? {});
  const best = entries.length ? Math.max(...entries.map(([, v]) => v)) : 0;
  const probs = entries.map(([k, v]) => `${k}=${fmtP(v)}`).join(" ");
  return `${q.id}: SCORE=${fmtP(answer.score)} SCALE=0..${rungs.length ? rungs.length - 1 : "?"} RUNG=${rungs.length ? rungs[idx] ?? idx : "?"} P=${fmtP(best)} CONF=${conf(best)} ALL[${probs}]`;
}

function toQuestion({id, type, criteria, instructions}: QuestionInput): EvaluationQuestion {
  if (type === "choice") {
    if (!criteria || typeof criteria !== "object" || !Object.keys(criteria).length) {
      throw new Error(`question "${id}": type "choice" needs criteria as { option: description }`);
    }
    return {
      type: "choice",
      instructions,
      criteria,
    };
  }
  if (type === "score") {
    if (!Array.isArray(criteria) || criteria.length < 2) {
      throw new Error(`question "${id}": type "score" needs criteria as an ordered array of 2+ labels`);
    }
    return {
      type: "score",
      instructions,
      criteria,
    };
  }

  return {
    type: "boolean",
    instructions,
    ...(criteria?.true || criteria?.false ? {
      criteria: {
        true: criteria.true ?? null,
        false: criteria.false ?? null,
      }
    } : {}),
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "jev",
    label: "Jev Decision",
    description:
      "Ask a fast evaluation model for typed decisions about a situation. Returns choices, scores, and probabilities — cheaper and steadier than reasoning about it yourself. Use for classification, routing, rubric scoring, and yes/no verification.\n"
      + "RESULT FORMAT (always non-empty, exactly one line per question id, in the order asked):\n"
      + "  <id>: BOOLEAN=true|false P=<0..1> CONF=HIGH|MED|LOW\n"
      + "  <id>: CHOICE=<option> P=<0..1> CONF=HIGH|MED|LOW ALL[<option>=<0..1> ...]\n"
      + "  <id>: SCORE=<float> SCALE=0..<n> RUNG=<label> P=<0..1> CONF=HIGH|MED|LOW ALL[<rungIndex>=<0..1> ...]\n"
      + "Bounded by a leading 'JEV_ANSWERED=<k>/<n> MODEL=typesafe-ai/jev' header and a trailing 'usage: in= out= total= cost=' line. "
      + "A line is never blank and the result is never empty: if you think it came back empty, re-read the tool output before reporting so. "
      + "A question the model omits shows as '<id>: NO_ANSWER'.",
    promptSnippet: "Get fast typed decisions (choice/score/boolean + probabilities) from the Jev evaluation model",
    promptGuidelines: [
      "Use jev when you need a quick judgement call: classify input, route to one of several options, score against a rubric, or verify whether a condition holds.",
      "Pass the whole relevant situation as `state` and ask all questions in one call; they are answered in parallel.",
      "For choice questions, criteria is { option: description }. For score, an ordered array of 2+ labels. For boolean, optional { true: description, false: description }.",
      "Read the tagged fields, not prose: `BOOLEAN=`/`CHOICE=`/`SCORE=` is the answer, `P=` its probability, `CONF=` its band, `ALL[...]` the full distribution.",
      "Act on CONF: HIGH (P>=0.8) commit; MED (0.6-0.8) commit only if cheap to reverse; LOW (<0.6) or NO_ANSWER means gather more evidence first.",
      "The result always carries one line per question plus header and usage lines — if you cannot see them, re-read the tool result rather than claiming it was empty.",
    ],
    parameters: Type.Object({
      state: Type.String({
        description: "The situation to judge: facts, a diff, tool output, a request, or any shared context. Plain text.",
      }),
      questions: Type.Array(
        Type.Object({
          id: Type.String({ description: "Short key for the answer, e.g. \"route\" or \"shouldCommit\"" }),
          type: StringEnum(["boolean", "choice", "score"] as const, {
            description: "boolean = probability yes/no; choice = pick one option; score = rate on an ordered scale",
          }),
          instructions: Type.String({ description: "The question being asked about the state" }),
          criteria: Type.Optional(
            Type.Any({
              description:
                'choice: { option: "description" }; score: ordered array of 2+ labels; boolean: optional { true: "desc", false: "desc" }',
            }),
          ),
        }),
        { description: "One or more questions to answer against the same state" },
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const questions = params.questions;
      if (!questions.length) throw new Error("jev: at least one question required");

      const evaluated = Object.fromEntries(questions.map((q) => [q.id, toQuestion(q as QuestionInput)]));
      const apiKey = process.env.VERCEL_AI_API_KEY;
      if (!apiKey) {
        throw new Error("jev: set the VERCEL_AI_API_KEY environment variable (Vercel AI Gateway key)");
      }

      const model = createGateway({apiKey}).evaluationModel("typesafe-ai/jev");

      const result = await evaluate({
        model,
        state: params.state,
        questions: evaluated,
        abortSignal: signal,
      });

      const answers = result.answers as Record<string, Answer>;
      const lines = questions.map((q) => formatAnswer(q as QuestionInput, answers[q.id]));

      const usageIn = result.usage.inputTokens ?? 0;
      const usageOut = result.usage.outputTokens ?? 0;
      const gateway = (result.providerMetadata as { gateway?: { cost?: string; gatewayCost?: string } })?.gateway;
      const cost = Number(gateway?.gatewayCost ?? gateway?.cost ?? 0) || 0;

      return {
        content: [{
          type: "text" as const,
          text: [
            `JEV_ANSWERED=${lines.length}/${questions.length} MODEL=typesafe-ai/jev`,
            ...lines,
            `usage: in=${usageIn} out=${usageOut} total=${result.usage.totalTokens ?? usageIn + usageOut} cost=$${cost.toFixed(4)}`,
          ].join("\n"),
        }],
        details: { model: "typesafe-ai/jev", answers, usage: result.usage },
        usage: {
          input: usageIn,
          output: usageOut,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: result.usage.totalTokens ?? usageIn + usageOut,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
        },
      };
    },
  });
}
