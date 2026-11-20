export type NavRevisionKey='library'|'cards'|'commitments'|'matters'|'memory'|'sources'|'plugins';

/** One navigation revision per owner-visible resource collection. Values are
 * opaque strings: callers compare them for equality, never parse or order them. */
export type NavState={
  revisions:Record<NavRevisionKey,string>;
  badges:{ideas?:number;connections?:boolean;[id:string]:number|boolean|undefined};
};
