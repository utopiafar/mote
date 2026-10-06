/** Source packs may declare exposure without teaching the query agent source-specific
 * semantic rules. These host-owned rules govern a representation at one operation
 * and processing phase; captured content cannot change them. */
export type EvidenceRepresentation='capture'|'material'|'segment'|'image'|'memory';
export type EvidenceOperation='discover'|'expand'|'memory';
export type EvidencePhase='pending'|'partial'|'complete';
export type EvidenceExposureContext={sourceKind:string;sourceId?:string;representation:EvidenceRepresentation;operation:EvidenceOperation;phase:EvidencePhase};
export type EvidenceExposureRule={sourceKind?:string;sourceId?:string;representation?:EvidenceRepresentation;operation?:EvidenceOperation;phase?:EvidencePhase;allow:boolean};
export type RecipeExposureRoute={audience:string;operation:string;phase:string;readProjection:string};

const defaults:readonly EvidenceExposureRule[]=[
  // A sampled screen stream is useful for measured activity, but its individual
  // screenshots are not a default query catalog. Published segments and
  // materials can still lead to selected original IDs for verification.
  {sourceKind:'screen',representation:'capture',operation:'discover',allow:false},
  // Coding conversations are presented as one session material. Their raw
  // archive/event rows are never independently offered to a query agent.
  {sourceKind:'coding-agent',representation:'capture',allow:false},
  {sourceKind:'coding-agent',representation:'image',allow:false},
  // Memory requires the declared material dependencies to settle. Interactive
  // query reads all available material phases and sees the coverage state.
  {representation:'material',operation:'memory',phase:'pending',allow:false},
  {representation:'material',operation:'memory',phase:'partial',allow:false},
];

function matches(rule:EvidenceExposureRule,context:EvidenceExposureContext){
  return (rule.sourceKind===undefined||rule.sourceKind===context.sourceKind)
    &&(rule.sourceId===undefined||rule.sourceId===context.sourceId)
    &&(rule.representation===undefined||rule.representation===context.representation)
    &&(rule.operation===undefined||rule.operation===context.operation)
    &&(rule.phase===undefined||rule.phase===context.phase);
}

/** Explicit trusted rules take precedence over built-in defaults. No text,
 * topics, inferred intent, or model output are inputs to this decision. */
export class EvidenceExposurePolicy {
  private readonly rules:readonly EvidenceExposureRule[];
  private readonly overrides:readonly EvidenceExposureRule[];
  constructor(overrides:readonly EvidenceExposureRule[]=[]){
    this.overrides=overrides.map(rule=>({...rule}));
    this.rules=[...this.overrides,...defaults];
  }
  allows(context:EvidenceExposureContext,recipeRoutes?:readonly RecipeExposureRoute[],screenOriginalGrant=false){
    // A coding archive can contain thousands of raw events. No recipe route or
    // host override may disclose those events through the full-record tools.
    if(context.sourceKind==='coding-agent'&&['capture','image'].includes(context.representation))return false;
    // A screenshot UUID is not a capability. Only a current Material/segment
    // expansion in this query may grant the underlying original.
    if(context.sourceKind==='screen'&&context.operation!=='discover'&&
      ['capture','image'].includes(context.representation)&&!screenOriginalGrant)return false;
    if(recipeRoutes){
      const audience=context.operation==='memory'?'memory':'query';
      const operation=context.operation==='memory'?'derive':'ask';
      const phase=context.phase==='complete'?'ready':context.phase;
      // Only a full representation can satisfy a full-record tool. In
      // particular, a metadata projection never authorizes raw capture text.
      if(!recipeRoutes.some(route=>route.audience===audience&&route.operation===operation&&
        route.phase===phase&&route.readProjection===context.representation))return false;
      return this.overrides.find(rule=>matches(rule,context))?.allow??true;
    }
    return this.rules.find(rule=>matches(rule,context))?.allow??true;
  }
}

export const defaultEvidenceExposurePolicy=new EvidenceExposurePolicy();
