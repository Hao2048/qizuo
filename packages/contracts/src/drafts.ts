import { Type, type Static } from "typebox";
const Id = Type.String({ minLength: 1, maxLength: 200 });
export const DraftTarget = Type.Object({ kind: Type.Union([Type.Literal("chat"), Type.Literal("workbench")]), id: Type.Union([Id, Type.Null()]) });
export const ComposerDraft = Type.Object({
  text: Type.String({ maxLength: 100000 }),
  attachments: Type.Array(Type.Object({ kind: Type.Union([Type.Literal("text"), Type.Literal("image")]), name: Type.String({ maxLength: 200 }), data: Type.String({ maxLength: 6291456 }), mimeType: Type.Optional(Type.String({ maxLength: 100 })) }), { maxItems: 32 }),
  referenceIds: Type.Array(Id, { maxItems: 3, uniqueItems: true }),
  attachmentIds: Type.Array(Id, { maxItems: 6, uniqueItems: true }),
  recipient: Type.String({ maxLength: 200 }),
  evidence: Type.String({ maxLength: 16000 }),
  verificationCommands: Type.String({ maxLength: 64000 }),
  projectId: Type.Union([Id, Type.Null()]), roleId: Type.Union([Id, Type.Null()]),
  model: Type.Union([Type.Object({ provider: Id, modelId: Id }), Type.Null()]),
  thinking: Type.Union([Type.String({ maxLength: 30 }), Type.Null()]),
}, {additionalProperties:false});
export type ComposerDraft = Static<typeof ComposerDraft>;
export type DraftTarget = Static<typeof DraftTarget>;
export const EMPTY_COMPOSER_DRAFT: ComposerDraft = { text: "", attachments: [], referenceIds: [], attachmentIds: [], recipient: "", evidence: "", verificationCommands: "", projectId: null, roleId: null, model: null, thinking: null };
export const DraftReceipt = Type.Object({ draft: ComposerDraft, revision: Type.Integer({ minimum: 0 }) });
export type DraftReceipt = Static<typeof DraftReceipt>;
export const draftCommands = {
  "draft:get": { input: DraftTarget, output: DraftReceipt },
  "draft:save": { input: Type.Object({ ...DraftTarget.properties, revision: Type.Integer({ minimum: 0 }), patch: Type.Object(Type.Partial(ComposerDraft).properties,{additionalProperties:false}) }), output: Type.Object({ revision: Type.Integer({minimum:0}) }) },
  "draft:moveChat": { input: Type.Object({ taskId: Id, revision: Type.Integer({ minimum: 0 }) }), output: DraftReceipt },
} as const;
