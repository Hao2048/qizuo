import { Type, type Static } from "typebox";

/** Host-produced facts, never model-authored acceptance or an execution permission. */
export const CompletionReport = Type.Object({
  scope: Type.Union([Type.Literal("chat"), Type.Literal("workbench")]),
  id: Type.String(),
  assessedAt: Type.Integer(),
  token: Type.String(),
  fingerprint: Type.Optional(Type.String()),
  state: Type.Union([Type.Literal("in_progress"), Type.Literal("needs_attention"), Type.Literal("reply_ended"), Type.Literal("ready_for_acceptance"), Type.Literal("accepted")]),
  conditions: Type.Array(Type.Object({
    id: Type.String(), label: Type.String(),
    status: Type.Union([Type.Literal("passed"), Type.Literal("pending"), Type.Literal("failed"), Type.Literal("not_applicable")]),
    evidenceIds: Type.Array(Type.String()),
  })),
  evidence: Type.Array(Type.Object({
    id: Type.String(),
    kind: Type.Union([Type.Literal("execution"), Type.Literal("artifact"), Type.Literal("contract"), Type.Literal("verification"), Type.Literal("user_confirmation")]),
    summary: Type.String(),
    status: Type.Union([Type.Literal("current"), Type.Literal("stale"), Type.Literal("unverified")]),
    at: Type.Optional(Type.Number()),
    roleId: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()), hash: Type.Optional(Type.String()),
    reference: Type.Optional(Type.String()),
  })),
});
export type CompletionReport = Static<typeof CompletionReport>;
