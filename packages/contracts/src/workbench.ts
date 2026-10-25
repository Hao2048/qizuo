import { Type, type Static } from "typebox";
const Id = Type.String({ minLength: 1, maxLength: 200 });
export const WorkbenchApprovalMode = Type.Union([Type.Literal("ask"), Type.Literal("auto"), Type.Literal("allow")]);
export type WorkbenchApprovalMode = Static<typeof WorkbenchApprovalMode>;
export const RoleConfiguration = Type.Object({
  roleId: Id,
  name: Type.String(),
  intro: Type.String(),
  systemPrompt: Type.String(),
  preferredModel: Type.Union([
    Type.Object({ provider: Type.String(), modelId: Type.String() }),
    Type.Null(),
  ]),
  preferredThinking: Type.Union([Type.String(), Type.Null()]),
  boundSkills: Type.Optional(Type.Array(Type.String())),
  boundPlugins: Type.Optional(Type.Array(Type.String())),
});
export const RoleChangePreview = Type.Object({
  token: Type.String(),
  kind: Type.String(),
  fromName: Type.String(),
  toName: Type.String(),
  available: Type.Boolean(),
  changed: Type.Boolean(),
  changes: Type.Array(
    Type.Object({
      label: Type.String(),
      before: Type.String(),
      after: Type.String(),
    }),
  ),
  responsibility: Type.String(),
  ownedPaths: Type.Array(Type.String()),
  files: Type.Array(Type.Object({ path: Type.String(), kind: Type.String() })),
  contracts: Type.Array(Type.String()),
  blockedReason: Type.Union([Type.String(), Type.Null()]),
});
export type RoleChangePreview = Static<typeof RoleChangePreview>;
export const WorkbenchAttachment = Type.Object({
  id: Id,
  name: Type.String(),
  kind: Type.Union([Type.Literal("text"), Type.Literal("image")]),
  mimeType: Type.String(),
  bytes: Type.Integer(),
  roleIds: Type.Optional(Type.Array(Id, { maxItems: 8, uniqueItems: true })),
});
export type WorkbenchAttachment = Static<typeof WorkbenchAttachment>;
const DeliveryPath = Type.String({minLength:1,maxLength:500});
const DeliveryFields = Type.Array(Type.Object({
  pointer: Type.String({maxLength:500}),
  type: Type.Optional(Type.Union([Type.Literal("string"),Type.Literal("number"),Type.Literal("boolean"),Type.Literal("object"),Type.Literal("array"),Type.Literal("null")])),
  equals: Type.Optional(Type.Union([Type.String({maxLength:2000}),Type.Number(),Type.Boolean(),Type.Null()])),
},{additionalProperties:false}),{maxItems:64});
const DeliverySections = Type.Array(Type.Object({id:Type.String({pattern:"^[a-zA-Z][a-zA-Z0-9_-]*$"}),title:Type.String({minLength:1})},{additionalProperties:false}),{minItems:1});
// Mutually exclusive formats; optional Never keeps convenient TypeScript property access.
export const WorkbenchDeliverable = Type.Union([
 Type.Object({path:DeliveryPath,format:Type.Literal("json"),fields:Type.Optional(DeliveryFields),schema:Type.Optional(Type.Record(Type.String(),Type.Unknown())),includes:Type.Optional(Type.Never()),sections:Type.Optional(Type.Never())},{additionalProperties:false}),
 Type.Object({path:DeliveryPath,format:Type.Literal("text"),includes:Type.Optional(Type.Array(Type.String({minLength:1,maxLength:1000}),{maxItems:32})),sections:Type.Optional(DeliverySections),fields:Type.Optional(Type.Never()),schema:Type.Optional(Type.Never())},{additionalProperties:false}),
 Type.Object({path:DeliveryPath,format:Type.Union([Type.Literal("file"),Type.Literal("directory")]),fields:Type.Optional(Type.Never()),includes:Type.Optional(Type.Never()),sections:Type.Optional(Type.Never()),schema:Type.Optional(Type.Never())},{additionalProperties:false}),
]);
export const DeliveryDiagnostic = Type.Object({
 code:Type.String(),path:Type.Optional(Type.String()),pointer:Type.Optional(Type.String()),
 message:Type.String(),suggestion:Type.String(),
});
export type DeliveryDiagnostic = Static<typeof DeliveryDiagnostic>;
export type WorkbenchDeliverable = Static<typeof WorkbenchDeliverable>;
export const WorkbenchDeliveryCheck = Type.Object({
  diagnostics:Type.Optional(Type.Array(DeliveryDiagnostic)),
  status: Type.Union([Type.Literal("passed"),Type.Literal("failed")]),
  at: Type.Integer(),
  issues: Type.Array(Type.String()),
  files: Type.Array(Type.Object({path:Type.String(),hash:Type.String()})),
});
export type WorkbenchDeliveryCheck = Static<typeof WorkbenchDeliveryCheck>;
export const WorkbenchParticipant = Type.Object({
  deliveryContractVersion:Type.Optional(Type.Literal(1)),
  collaborationWait: Type.Optional(Type.String()),
  pluginResources: Type.Optional(Type.Array(Type.Object({resource:Type.String(),status:Type.Union([Type.Literal("waiting"),Type.Literal("using")]),position:Type.Integer()}))),
  deliverables: Type.Optional(Type.Array(WorkbenchDeliverable,{maxItems:64})),
  deliveryCheck: Type.Optional(WorkbenchDeliveryCheck),
  roleId: Id,
  name: Type.String(),
  enabled: Type.Boolean(),
  status: Type.String(),
  taskId: Type.Union([Id, Type.Null()]),
  responsibility: Type.String(),
  configuration: Type.Optional(RoleConfiguration),
  configurationChanged: Type.Optional(Type.Boolean()),
  unavailable: Type.Optional(Type.Boolean()),
  inheritedTaskId: Type.Optional(Id),
  inheritedSourceHash: Type.Optional(Type.String()),
});
/** Host-owned progress for one dispatched human request; never an execution instruction. */
export const WorkbenchRoundProgress = Type.Object({
  requestId: Id,
  roles: Type.Array(Type.Object({
    roleId: Id,
    summary: Type.Optional(Type.String({maxLength:300})),
    dependsOn: Type.Array(Id,{maxItems:8,uniqueItems:true}),
    stage: Type.Union([Type.Literal("queued"),Type.Literal("planning"),Type.Literal("ready"),Type.Literal("preparing"),Type.Literal("running"),Type.Literal("finished"),Type.Literal("interrupted")]),
  }),{maxItems:8}),
});
export const WorkbenchNotification = Type.Object({
  purpose: Type.Optional(Type.Union([Type.Literal("information"),Type.Literal("question"),Type.Literal("collaboration"),Type.Literal("delivery")])),
  automatic: Type.Optional(Type.Object({
    state: Type.Union([Type.Literal("queued"),Type.Literal("running"),Type.Literal("completed"),Type.Literal("blocked"),Type.Literal("interrupted")]),
    reason: Type.Optional(Type.String()),
    taskId: Type.Optional(Id),
    roleChain: Type.Array(Id,{maxItems:8,uniqueItems:true}),
  })),
  sourceTaskId: Id, sourceToolCallId: Id,
  status: Type.Union([Type.Literal("pending"),Type.Literal("delivered"),Type.Literal("handled")]),
  deliveredTaskId: Type.Optional(Id), deliveredAt: Type.Optional(Type.Integer()),
  handledTaskId: Type.Optional(Id), handledAt: Type.Optional(Type.Integer()),
  handlingNote: Type.Optional(Type.String({maxLength:1000})),
});
export const WorkbenchMessage = Type.Object({
  /** Host-generated execution receipt; never an automatic copy of private assistant text. */
  resultSource: Type.Optional(Type.Literal("host")),
  notification: Type.Optional(WorkbenchNotification),
  id: Id,
  requestId: Id,
  sender: Type.String(),
  senderName: Type.Optional(Type.String()),
  recipients: Type.Array(Type.String()),
  kind: Type.String(),
  text: Type.String(),
  at: Type.Integer(),
  attachments: Type.Optional(Type.Array(WorkbenchAttachment, { maxItems: 6 })),
});
export const WorkbenchContract = Type.Object({
  id: Id,
  title: Type.String(),
  content: Type.String(),
  version: Type.Integer(),
  roles: Type.Array(Id),
});
export const WorkbenchProposal = Type.Object({
  id: Id,
  contractId: Id,
  roleId: Id,
  baseVersion: Type.Integer(),
  content: Type.String(),
  reason: Type.String(),
  status: Type.String(),
});
/** Local receipts only; missing provider fields stay unknown. No prompts or private history. */
export const WorkbenchCall = Type.Object({
  id: Id, requestId: Id, roleId: Id, name: Type.String(),stage: Type.String(),
  provider: Type.String(),model: Type.String(),status: Type.String(),at: Type.Number(),
  firstResponseMs: Type.Union([Type.Number(),Type.Null()]),
  firstTextMs: Type.Union([Type.Number(),Type.Null()]),
  durationMs: Type.Union([Type.Number(),Type.Null()]),
});
export type WorkbenchCall = Static<typeof WorkbenchCall>;
export const WorkbenchUsage = Type.Object({
  rounds: Type.Optional(Type.Array(Type.Object({requestId: Id,at:Type.Number(),label:Type.String()}))),
  roles: Type.Array(Type.Object({
    roleId: Id, name: Type.String(),
    stage: Type.Union([Type.Literal("routing"), Type.Literal("planning"), Type.Literal("execution")]),
    calls: Type.Integer(), receiptCalls: Type.Integer(), failedCalls: Type.Integer(),
    interruptedCalls: Type.Integer(), activeCalls: Type.Integer(),
    inputTokens: Type.Union([Type.Number(), Type.Null()]),
    outputTokens: Type.Union([Type.Number(), Type.Null()]),
    cacheReadTokens: Type.Union([Type.Number(), Type.Null()]),
    cacheReceiptCalls: Type.Integer(),
    costUSD: Type.Union([Type.Number(), Type.Null()]), costReceiptCalls: Type.Integer(),
    lastDurationMs: Type.Union([Type.Number(), Type.Null()]),
    lastFirstResponseMs: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    lastFirstTextMs: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
  })),
});
export type WorkbenchUsage = Static<typeof WorkbenchUsage>;
export const Workbench = Type.Object({
  acceptance: Type.Optional(Type.Object({fingerprint:Type.String(),at:Type.Integer(),note:Type.String(),verificationAt:Type.Optional(Type.Number())})),
  roundProgress: Type.Optional(WorkbenchRoundProgress),
  id: Id,
  title: Type.String(),
  conversationOrigin: Type.Optional(
    Type.Object({
      taskId: Id,
      entryId: Id,
      requestId: Id,
      signature: Type.String(),
      summary: Type.String(),
    }),
  ),
  projectId: Type.Union([Id, Type.Null()]),
  phase: Type.String(),
  usage: Type.Optional(
    Type.Array(
      Type.Object({
        roleId: Id,
        percent: Type.Union([Type.Number(), Type.Null()]),
        cacheHitPercent: Type.Union([Type.Number(), Type.Null()]),
      }),
    ),
  ),
  access: Type.Optional(
    Type.Array(
      Type.Object({
        roleId: Id,
        commands: Type.Boolean(),
        approvalMode: Type.Optional(WorkbenchApprovalMode),
        network: Type.Boolean(),
        servers: Type.Array(Id, { maxItems: 16, uniqueItems: true }),
      }),
      { maxItems: 8 },
    ),
  ),
  verification: Type.Optional(
    Type.Object({
      status: Type.String(),
      fingerprint: Type.String(),
      currentCommand: Type.Optional(Type.String()),
      steps: Type.Array(
        Type.Object({
          command: Type.String(),
          code: Type.Union([Type.Integer(), Type.Null()]),
          output: Type.String(),
          durationMs: Type.Number(),
          cancelled: Type.Boolean(),
        }),
      ),
      at: Type.Number(),
    }),
  ),
  revision: Type.Integer(),
  participants: Type.Array(WorkbenchParticipant),
  roleHistory: Type.Optional(
    Type.Array(
      Type.Object({ roleId: Id, name: Type.String(), at: Type.Integer() }),
    ),
  ),
  messages: Type.Array(WorkbenchMessage),
  memories: Type.Optional(
    Type.Array(
      Type.Object({
        id: Id,
        roleId: Id,
        sourceTaskId: Id,
        memoryId: Type.Optional(Id),
        category: Type.Optional(
          Type.Union([Type.Literal("experience"), Type.Literal("preference")]),
        ),
        appliesTo: Type.Optional(Type.String()),
        evidence: Type.Optional(Type.String()),
        projectOnly: Type.Optional(Type.Boolean()),
        title: Type.String(),
        content: Type.String(),
        status: Type.String(),
      }),
    ),
  ),
  recommendations: Type.Array(Id),
  contracts: Type.Array(WorkbenchContract),
  proposals: Type.Array(WorkbenchProposal),
  createdAt: Type.Integer(),
  updatedAt: Type.Integer(),
});
export type Workbench = Static<typeof Workbench>;
export type WorkbenchParticipant = Static<typeof WorkbenchParticipant>;
export type WorkbenchMessage = Static<typeof WorkbenchMessage>;
export const WorkbenchReview = Type.Object({
  token: Type.String(),
  taskId: Id,
  total: Type.Integer(),
  conflicts: Type.Integer(),
  blockedReason: Type.Union([Type.String(), Type.Null()]),
  files: Type.Array(
    Type.Object({
      path: Type.String(),
      kind: Type.String(),
      conflict: Type.Boolean(),
      reason: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});
export type WorkbenchReview = Static<typeof WorkbenchReview>;
const ReviewText = Type.Object({
  text: Type.String(),
  binary: Type.Boolean(),
  truncated: Type.Boolean(),
  bytes: Type.Integer(),
});
export const WorkbenchReviewFile = Type.Object({
  path: Type.String(),
  before: ReviewText,
  after: ReviewText,
});
export type WorkbenchReviewFile = Static<typeof WorkbenchReviewFile>;
export const workbenchCommands = {
  "workbench:fromConversation": {
    input: Type.Object({
      taskId: Id,
      entryId: Id,
      requestId: Id,
      title: Type.String({ minLength: 1, maxLength: 200 }),
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      roleIds: Type.Array(Id, { maxItems: 8, uniqueItems: true }),
      confirmed: Type.Literal(true),
    }),
    output: Workbench,
  },
  "workbench:reviewImage": {
    input: Type.Object({
      id: Id,
      roleId: Id,
      token: Type.String({ minLength: 1, maxLength: 64 }),
      path: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    output: Type.Object({ data: Type.String(), mimeType: Type.String() }),
  },
  "workbench:roleChangePreview": {
    input: Type.Object({ id: Id, roleId: Id, targetRoleId: Type.Optional(Id) }),
    output: RoleChangePreview,
  },
  "workbench:applyRoleChange": {
    input: Type.Object({
      id: Id,
      roleId: Id,
      targetRoleId: Id,
      token: Type.String(),
      summary: Type.String({ minLength: 1, maxLength: 4000 }),
      confirmed: Type.Literal(true),
    }),
    output: Workbench,
  },
  "workbench:attach": {
    input: Type.Object({
      id: Id,
      name: Type.String({ minLength: 1, maxLength: 200 }),
      kind: Type.Union([Type.Literal("text"), Type.Literal("image")]),
      mimeType: Type.String({ maxLength: 100 }),
      data: Type.String({ maxLength: 6291456 }),
    }),
    output: WorkbenchAttachment,
  },
  "workbench:readAttachment": {
    input: Type.Object({ id: Id, attachmentId: Id }),
    output: Type.Object({
      attachment: WorkbenchAttachment,
      data: Type.String(),
    }),
  },
  "workbench:discardAttachment": {
    input: Type.Object({ id: Id, attachmentId: Id }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "workbench:review": {
    input: Type.Object({
      id: Id,
      roleId: Id,
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    output: WorkbenchReview,
  },
  "workbench:reviewFile": {
    input: Type.Object({
      id: Id,
      roleId: Id,
      token: Type.String({ minLength: 1, maxLength: 64 }),
      path: Type.String({ minLength: 1, maxLength: 1000 }),
    }),
    output: WorkbenchReviewFile,
  },
  "workbench:preview": {
    input: Type.Object({id: Id, roleId: Id, token: Type.String({minLength: 1, maxLength: 64}), path: Type.String({minLength: 1, maxLength: 1000}), download: Type.Optional(Type.Boolean())}),
    output: Type.Object({url: Type.String()}),
  },
  "workbench:openDocument": {
    input: Type.Object({id: Id, roleId: Id, token: Type.String({minLength: 1, maxLength: 64}), path: Type.String({minLength: 1, maxLength: 1000})}),
    output: Type.Object({ok: Type.Boolean()}),
  },
  "workbench:revealFile": {
    input: Type.Object({id: Id, roleId: Id, token: Type.String({minLength: 1, maxLength: 64}), path: Type.String({minLength: 1, maxLength: 1000})}),
    output: Type.Object({ok: Type.Boolean()}),
  },
  "workbench:repair": {
    input: Type.Object({
      id: Id,
      roleId: Id,
      requestId: Id,
      verificationAt: Type.Number(),
      fingerprint: Type.String({ maxLength: 64 }),
      instructions: Type.String({ maxLength: 4000 }),
    }),
    output: Type.Object({ accepted: Type.Boolean() }),
  },
  "workbench:setApprovalMode": {
    input: Type.Object({ id: Id, roleId: Id, approvalMode: WorkbenchApprovalMode }),
    output: Workbench,
  },
  "workbench:setAccess": {
    input: Type.Object({
      id: Id,
      roleId: Id,
      commands: Type.Boolean(),
      network: Type.Boolean(),
      servers: Type.Array(Id, { maxItems: 16, uniqueItems: true }),
    }),
    output: Workbench,
  },
  "workbench:verificationPlan": {
    input: Type.Object({ id: Id }),
    output: Type.Object({
      commands: Type.Array(Type.String()),
      network: Type.Boolean(),
    }),
  },
  "workbench:verify": {
    input: Type.Object({
      id: Id,
      commands: Type.Array(Type.String({ minLength: 1, maxLength: 8000 }), {
        minItems: 1,
        maxItems: 8,
      }),
      network: Type.Boolean(),
    }),
    output: Type.Object({ accepted: Type.Boolean() }),
  },
  "workbench:create": {
    input: Type.Object({
      title: Type.String({ minLength: 1, maxLength: 200 }),
      projectId: Type.Optional(Id),
      roleIds: Type.Optional(
        Type.Array(Id, { maxItems: 8, uniqueItems: true }),
      ),
    }),
    output: Workbench,
  },
  "workbench:list": {
    input: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 200 })),
      cursor: Type.Optional(Type.String({ maxLength: 1000 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    }),
    output: Type.Object({
      items: Type.Array(Workbench),
      nextCursor: Type.Union([Type.String(), Type.Null()]),
    }),
  },
  "workbench:draftFiles": { input: Type.Object({id:Id}), output: Type.Object({attachments:Type.Array(WorkbenchAttachment)}) },
  "workbench:get": { input: Type.Object({ id: Id }), output: Workbench },
  "workbench:usage": { input: Type.Object({ id: Id, requestId:Type.Optional(Id) }), output: WorkbenchUsage },
  "workbench:usageCalls": {
    input:Type.Object({id:Id, requestId:Type.Optional(Id),cursor:Type.Optional(Type.String({maxLength:1000}))}),
    output:Type.Object({calls:Type.Array(WorkbenchCall),nextCursor:Type.Union([Type.String(),Type.Null()])}),
  },
  "workbench:send": {
    input: Type.Object({
      draftRevision: Type.Optional(Type.Integer({minimum:0})),
      id: Id,
      text: Type.String({ minLength: 1, maxLength: 16000 }),
      requestId: Id,
      roleId: Type.Optional(Id),
      attachmentIds: Type.Optional(
        Type.Array(Id, { maxItems: 6, uniqueItems: true }),
      ),
    }),
    output: Type.Object({ accepted: Type.Boolean() }),
  },
  "workbench:resume": {
    input: Type.Object({ id: Id, roleId: Type.Optional(Id), requestId: Id }),
    output: Type.Object({ accepted: Type.Boolean() }),
  },
  "workbench:confirm": {
    input: Type.Object({
      id: Id,
      roleIds: Type.Array(Id, { minItems: 2, maxItems: 8, uniqueItems: true }),
    }),
    output: Type.Object({ accepted: Type.Boolean() }),
  },
  "workbench:setEnabled": {
    input: Type.Object({ id: Id, roleId: Id, enabled: Type.Boolean() }),
    output: Workbench,
  },
  "workbench:stop": {
    input: Type.Object({ id: Id }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "workbench:delete": {
    input: Type.Object({ id: Id }),
    output: Type.Object({ ok: Type.Boolean() }),
  },
  "workbench:propose": {
    input: Type.Object({
      id: Id,
      roleId: Id,
      contractId: Id,
      baseVersion: Type.Integer({ minimum: 1 }),
      content: Type.String({ minLength: 1, maxLength: 8000 }),
      reason: Type.String({ maxLength: 2000 }),
    }),
    output: Workbench,
  },
  "workbench:keepContract": {
    input: Type.Object({ id: Id, contractId: Id, revision: Type.Integer() }),
    output: Workbench,
  },
  "workbench:choose": {
    input: Type.Object({ id: Id, proposalId: Id, revision: Type.Integer() }),
    output: Workbench,
  },
  "workbench:finish": {
    input: Type.Object({
      completionToken: Type.Optional(Type.String({minLength:64,maxLength:64})),
      id: Id,
      evidence: Type.String({ minLength: 1, maxLength: 4000 }),
      memoryIds: Type.Array(Id, { maxItems: 40, uniqueItems: true }),
    }),
    output: Workbench,
  },
  "workbench:apply": {
    input: Type.Object({
      id: Id,
      roleId: Id,
      reviewToken: Type.String({ minLength: 1, maxLength: 64 }),
    }),
    output: Type.Object({
      ok: Type.Boolean(),
      files: Type.Array(Type.String()),
    }),
  },
} as const;
