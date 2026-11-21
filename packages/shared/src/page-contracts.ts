import {z} from 'zod';
import {codingNextStepSchema} from './assistant-contracts.js';
import {evidenceDependenciesSchema} from './evidence-dependencies.js';
import {sourceContextDeclarationSchema} from './material-context.js';
import {operationStateSchema} from './operations.js';
import {ownerQuestionEvidenceSchema} from './owner-questions.js';
import {queryScopeSchema} from './query-scope.js';
import {sourceIdSchema} from './sources.js';

/** Browser page contracts for the owner's central instance. These describe
 * meaning that surfaces exchange; they confer no evidence permission.
 *
 * Existing owner endpoints reused by page actions (no new transport):
 * - start an idea / accept a card: POST /api/assistant/tasks {cardId, expectedRevision}
 * - later or ignore an idea: POST /api/assistant-cards/:id/feedback
 * - answer an idea: the chat's about=question:<id> or about=card:<id>
 * - complete, dismiss or reject a goal: AssistantCommitments.correct with
 *   expectedRevision (apps/server/src/assistant-commitments.ts)
 * - cancel onboarding: POST /api/assistant/onboarding/:id/cancel
 *
 * Transports owned by the implementing server cards:
 * - feed: GET /api/assistant-cards with the filters below (FE1)
 * - ideas: GET /api/assistant/ideas, POST /api/assistant/ideas/ignore-all (ID1)
 * - goals: GET /api/assistant/goals, POST /api/assistant/goals/:id/follow,
 *   POST /api/assistant/goals (GO1)
 * - connections: GET /api/connections/services (CN1)
 * - onboarding: POST/GET /api/assistant/onboarding (CN2)
 */

const recordRevision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Whole-view revision for cache and conditional reads. */
const pageRevision=z.string().min(1).max(200);
const timestamp=z.string().max(64).datetime({offset:true});
const unsafeControl=/[\u0000-\u001f\u007f]/;
/** Single-line owner-facing text. Rejects blank and control characters. */
const pageText=(max:number)=>z.string().trim().min(1).max(max).refine(value=>!unsafeControl.test(value),{message:'Text cannot contain control characters'});
/** Stored prose may keep line breaks but no other control characters. */
const documentText=(max:number)=>z.string().min(1).max(max)
  .refine(value=>value.trim().length>0,{message:'Text cannot be blank'})
  .refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),{message:'Text cannot contain control characters'});
const timeZone=z.string().min(1).max(100).refine(value=>{
  try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}
},{message:'Unknown time zone'});
/** Existing HTTP transports carry the scope as a JSON-encoded query value. */
const scopeParam=z.string().max(16000).transform((raw,ctx)=>{
  try{return queryScopeSchema.parse(JSON.parse(raw));}
  catch{ctx.addIssue({code:z.ZodIssueCode.custom,message:'Invalid page scope'});return z.NEVER;}
});
const uniqueValues=<T>(values:T[])=>new Set(values).size===values.length;

/* ── 动态 ─────────────────────────────────────────────────────────────── */

export const feedKindSchema=z.enum(['activity','briefing','artifact','discovery']);
export type FeedKind=z.infer<typeof feedKindSchema>;
/** Existing card kinds plus discoveries projected from /api/insights. */
export const feedItemKindSchema=z.enum(['activity','suggestion','briefing','artifact','question','discovery']);
export type FeedItemKind=z.infer<typeof feedItemKindSchema>;
export const feedWindowSchema=z.enum(['today','3d','week','earlier']);
export type FeedWindow=z.infer<typeof feedWindowSchema>;

export const assistantEvidenceOriginSchema=z.object({
  id:z.string().uuid(),
  offset:z.number().int().nonnegative().optional(),
  sourceId:sourceIdSchema.optional(),
  provider:z.enum(['codex','claude','kimi','opencode']).optional(),
  speaker:z.enum(['user','owner','agent']).optional(),
  recordedAt:timestamp.optional(),
  appName:z.string().min(1).max(200).optional(),
}).strict();
export type AssistantEvidenceOriginView=z.infer<typeof assistantEvidenceOriginSchema>;

export const matterEvidenceViewSchema=z.object({
  id:z.string().uuid(),
  title:z.string().max(1000),
  sourceId:sourceIdSchema.optional(),
  deviceId:sourceIdSchema.optional(),
  at:timestamp,
}).strict();

export const assistantCardFeedbackViewSchema=z.object({
  version:z.string().min(1).max(200),
  action:z.enum(['later','ignore','correct','never_remind']),
  note:documentText(8000).optional(),
  until:timestamp.optional(),
  evidenceStale:z.boolean().optional(),
  createdAt:timestamp,
}).strict();
export type AssistantCardFeedbackView=z.infer<typeof assistantCardFeedbackViewSchema>;

/** The existing card projection plus the four model-supplied feed fields.
 * A discovery is projected into the same shape so one list can mix both. */
export const feedItemSchema=z.object({
  id:z.string().uuid(),
  kind:feedItemKindSchema,
  matterId:z.string().uuid().nullable(),
  version:z.string().min(1).max(200),
  state:z.enum(['open','resolved','stale']),
  revision:recordRevision,
  title:pageText(500),
  body:documentText(32000),
  evidence:z.array(ownerQuestionEvidenceSchema).max(100),
  reminderReason:pageText(2000).optional(),
  codingNextStep:codingNextStepSchema.optional(),
  evidenceDependencies:evidenceDependenciesSchema,
  sourceContextDependencies:z.array(sourceContextDeclarationSchema).max(100).optional(),
  evidenceStale:z.boolean().optional(),
  feedback:z.array(assistantCardFeedbackViewSchema).max(1000),
  readAt:timestamp.nullable(),
  acceptedTaskId:z.string().uuid().nullable(),
  taskScope:queryScopeSchema.nullable(),
  taskEvidence:z.array(matterEvidenceViewSchema).max(1000),
  evidenceOrigins:z.array(assistantEvidenceOriginSchema).max(100),
  createdAt:timestamp,
  updatedAt:timestamp,
  category:pageText(8).optional(),
  subject:pageText(40).optional(),
  action:pageText(16).optional(),
  gist:pageText(120).optional(),
}).strict();
export type FeedItem=z.infer<typeof feedItemSchema>;

export const feedCategoryCountSchema=z.object({name:pageText(8),count:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).strict();
export type FeedCategoryCount=z.infer<typeof feedCategoryCountSchema>;

export const feedPageSchema=z.object({
  items:z.array(feedItemSchema),
  nextCursor:z.string().max(1000).nullable(),
  categories:z.array(feedCategoryCountSchema).max(100),
  revision:pageRevision,
}).strict();
export type FeedPage=z.infer<typeof feedPageSchema>;

/** CSV kinds keep the existing GET query shape; repeated kinds are rejected. */
export const feedQuerySchema=z.object({
  kinds:z.string().max(120).transform(value=>value.split(',')).pipe(z.array(feedKindSchema).min(1).max(4)
    .refine(values=>uniqueValues(values),{message:'Kinds must be unique'})).optional(),
  window:feedWindowSchema.default('3d'),
  tz:timeZone.optional(),
  unread:z.literal('1').optional(),
  category:pageText(8).optional(),
  q:pageText(200).optional(),
  limit:z.coerce.number().int().min(1).max(50).default(30),
  cursor:z.string().max(1000).optional(),
  scope:scopeParam,
}).strict();
export type FeedQuery=z.infer<typeof feedQuerySchema>;

/* ── 点子 ─────────────────────────────────────────────────────────────── */

export const ideaSourceSchema=z.enum(['card','owner-question']);
export type IdeaSource=z.infer<typeof ideaSourceSchema>;
export const ideaKindSchema=z.enum(['suggestion','question','needs-info']);
export type IdeaKind=z.infer<typeof ideaKindSchema>;
export const ideaActionSchema=z.enum(['start','later','ignore','answer']);
export type IdeaAction=z.infer<typeof ideaActionSchema>;

export const ideaItemSchema=z.object({
  id:z.string().uuid(),
  source:ideaSourceSchema,
  kind:ideaKindSchema,
  title:pageText(80),
  detail:pageText(200).optional(),
  revision:recordRevision,
  seq:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  actions:z.array(ideaActionSchema).min(1).max(4).refine(values=>uniqueValues(values),{message:'Actions must be unique'}),
}).strict();
export type IdeaItem=z.infer<typeof ideaItemSchema>;

export const startedIdeaSchema=z.object({
  taskId:z.string().uuid(),
  title:pageText(80),
  state:operationStateSchema,
  progress:pageText(80).optional(),
  updatedAt:timestamp,
}).strict();
export type StartedIdea=z.infer<typeof startedIdeaSchema>;

export const ideasViewSchema=z.object({
  revision:pageRevision,
  watermark:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mine:z.array(ideaItemSchema).max(1000),
  yours:z.array(ideaItemSchema).max(1000),
  started:z.array(startedIdeaSchema).max(1000),
}).strict();
export type IdeasView=z.infer<typeof ideasViewSchema>;

export const ideasQuerySchema=z.object({scope:scopeParam}).strict();
export type IdeasQuery=z.infer<typeof ideasQuerySchema>;

/** Ignore only what the surface has already seen. Newer cards stay. */
export const ideasIgnoreAllInputSchema=z.object({
  upToSeq:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type IdeasIgnoreAllInput=z.infer<typeof ideasIgnoreAllInputSchema>;

export const ideasIgnoreAllResultSchema=z.object({
  ignored:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  revision:pageRevision,
}).strict();
export type IdeasIgnoreAllResult=z.infer<typeof ideasIgnoreAllResultSchema>;

/* ── 目标 ─────────────────────────────────────────────────────────────── */

export const goalTemplateSchema=z.enum(['project','travel','reading']);
export type GoalTemplate=z.infer<typeof goalTemplateSchema>;
export const goalItemKindSchema=z.enum(['commitment','todo','event']);
export type GoalItemKind=z.infer<typeof goalItemKindSchema>;
export const goalDirectionSchema=z.enum(['theirs','mine']);
export type GoalDirection=z.infer<typeof goalDirectionSchema>;
export const goalDueStateSchema=z.enum(['overdue','today','soon']);
export type GoalDueState=z.infer<typeof goalDueStateSchema>;
export const goalActionSchema=z.enum(['complete','dismiss','reject','follow']);
export type GoalAction=z.infer<typeof goalActionSchema>;

export const goalGroupKeySchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('matter'),id:z.string().uuid(),title:pageText(500),template:goalTemplateSchema.optional()}).strict(),
  z.object({kind:z.literal('person'),name:pageText(80)}).strict(),
  z.object({kind:z.literal('none')}).strict(),
]);
export type GoalGroupKey=z.infer<typeof goalGroupKeySchema>;

export const goalDueSchema=z.object({text:pageText(500),at:timestamp.nullable()}).strict();
export type GoalDue=z.infer<typeof goalDueSchema>;

export const goalProgressSchema=z.object({
  summary:pageText(120),
  at:timestamp,
  evidenceId:z.string().uuid().optional(),
}).strict();
export type GoalProgress=z.infer<typeof goalProgressSchema>;

export const goalFollowupSchema=z.object({followed:z.boolean()}).strict();
export type GoalFollowup=z.infer<typeof goalFollowupSchema>;

export const goalItemSchema=z.object({
  id:z.string().uuid(),
  kind:goalItemKindSchema,
  title:pageText(80),
  direction:goalDirectionSchema,
  due:goalDueSchema.optional(),
  dueState:goalDueStateSchema.optional(),
  lastProgress:goalProgressSchema.optional(),
  followup:goalFollowupSchema.optional(),
  inferred:z.boolean(),
  revision:recordRevision,
  actions:z.array(goalActionSchema).min(1).max(4).refine(values=>uniqueValues(values),{message:'Actions must be unique'}),
}).strict();
export type GoalItem=z.infer<typeof goalItemSchema>;

export const goalGroupSchema=z.object({
  key:goalGroupKeySchema,
  theirs:z.array(goalItemSchema).max(1000),
  mine:z.array(goalItemSchema).max(1000),
  unconfirmed:z.array(goalItemSchema).max(1000),
}).strict();
export type GoalGroup=z.infer<typeof goalGroupSchema>;

export const goalsViewSchema=z.object({
  revision:pageRevision,
  groups:z.array(goalGroupSchema).max(1000),
}).strict();
export type GoalsView=z.infer<typeof goalsViewSchema>;

export const goalsQuerySchema=z.object({
  group:z.enum(['matter','person']),
  scope:scopeParam,
}).strict();
export type GoalsQuery=z.infer<typeof goalsQuerySchema>;

export const goalFollowInputSchema=z.object({expectedRevision:recordRevision}).strict();
export type GoalFollowInput=z.infer<typeof goalFollowInputSchema>;

/** A hand-entered goal is always the owner's; the server fixes direction. */
export const goalCreateInputSchema=z.object({
  title:pageText(80),
  due:z.object({text:pageText(500),at:timestamp.nullable().optional()}).strict().optional(),
}).strict();
export type GoalCreateInput=z.infer<typeof goalCreateInputSchema>;

/* ── 连接 ─────────────────────────────────────────────────────────────── */

export const serviceKindSchema=z.enum(['service','ai-access']);
export type ServiceKind=z.infer<typeof serviceKindSchema>;
export const serviceStateSchema=z.enum(['connected','reauth','error','paused']);
export type ServiceState=z.infer<typeof serviceStateSchema>;
export const serviceActionSchema=z.enum(['sync','dry-run','reauth','pause','resume','remove']);
export type ServiceAction=z.infer<typeof serviceActionSchema>;

export const connectionJobSchema=z.object({
  kind:pageText(40),
  every:pageText(40).optional(),
  lastAt:timestamp.optional(),
  lastCount:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
export type ConnectionJob=z.infer<typeof connectionJobSchema>;

export const serviceItemSchema=z.object({
  id:z.string().min(1).max(128),
  name:pageText(80),
  kind:serviceKindSchema,
  state:serviceStateSchema,
  jobs:z.array(connectionJobSchema).max(50),
  tools:z.array(pageText(512)).max(100),
  actions:z.array(serviceActionSchema).min(1).max(6).refine(values=>uniqueValues(values),{message:'Actions must be unique'}),
}).strict();
export type ServiceItem=z.infer<typeof serviceItemSchema>;

export const servicesViewSchema=z.object({
  revision:pageRevision,
  services:z.array(serviceItemSchema).max(200),
}).strict();
export type ServicesView=z.infer<typeof servicesViewSchema>;

/* ── 认识我 ───────────────────────────────────────────────────────────── */

export const onboardingStateSchema=z.enum(['pending','running','completed','failed','cancelled']);
export type OnboardingState=z.infer<typeof onboardingStateSchema>;

export const onboardingStartInputSchema=z.object({
  sources:z.array(sourceIdSchema).min(1).max(50).refine(values=>uniqueValues(values),{message:'Sources must be unique'}),
  window:z.object({days:z.number().int().min(1).max(365)}).strict(),
}).strict();
export type OnboardingStartInput=z.infer<typeof onboardingStartInputSchema>;

export const onboardingStartResultSchema=z.object({
  id:z.string().uuid(),
  revision:recordRevision,
}).strict();
export type OnboardingStartResult=z.infer<typeof onboardingStartResultSchema>;

export const onboardingCountsSchema=z.object({
  sources:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  materials:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  memories:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ideas:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  feed:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  skippedSources:z.number().int().positive().max(50).optional(),
}).strict();
export type OnboardingCounts=z.infer<typeof onboardingCountsSchema>;

export const onboardingViewSchema=z.object({
  state:onboardingStateSchema,
  counts:onboardingCountsSchema,
}).strict();
export type OnboardingView=z.infer<typeof onboardingViewSchema>;

/* ── 去聊 ─────────────────────────────────────────────────────────────── */

export const CHAT_ABOUT_PARAM='about' as const;

const aboutIdSchema=z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/,{message:'Invalid reference identity'});
/** The ref part without the leading `material:` scheme token. */
const aboutMaterialRefSchema=z.string().regex(/^mat_[a-f0-9]{64}@[a-f0-9]{64}$/,{message:'Invalid material reference'});

export const aboutRefSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('card'),id:aboutIdSchema}).strict(),
  z.object({kind:z.literal('question'),id:aboutIdSchema}).strict(),
  z.object({kind:z.literal('commitment'),id:aboutIdSchema}).strict(),
  z.object({kind:z.literal('matter'),id:aboutIdSchema}).strict(),
  z.object({kind:z.literal('memory'),id:aboutIdSchema}).strict(),
  z.object({kind:z.literal('evidence'),id:aboutIdSchema}).strict(),
  z.object({kind:z.literal('material'),ref:aboutMaterialRefSchema}).strict(),
]);
export type AboutRef=z.infer<typeof aboutRefSchema>;

/** Serialize one typed reference for the chat URL. Invalid input throws. */
export function formatAboutRef(ref:AboutRef):string{
  const parsed=aboutRefSchema.parse(ref);
  return parsed.kind==='material'?`material:${parsed.ref}`:`${parsed.kind}:${parsed.id}`;
}

/** Parse one `kind:value` reference. Any malformed or unknown value is null. */
export function parseAboutRef(text:string):AboutRef|null{
  if(typeof text!=='string'||text.length<3||text.length>256)return null;
  const separator=text.indexOf(':');
  if(separator<1)return null;
  const kind=text.slice(0,separator),value=text.slice(separator+1);
  if(kind==='material'){
    const ref=aboutMaterialRefSchema.safeParse(value);
    return ref.success?{kind:'material',ref:ref.data}:null;
  }
  const id=aboutIdSchema.safeParse(value);
  if(!id.success)return null;
  switch(kind){
    case 'card':return {kind:'card',id:id.data};
    case 'question':return {kind:'question',id:id.data};
    case 'commitment':return {kind:'commitment',id:id.data};
    case 'matter':return {kind:'matter',id:id.data};
    case 'memory':return {kind:'memory',id:id.data};
    case 'evidence':return {kind:'evidence',id:id.data};
    default:return null;
  }
}
