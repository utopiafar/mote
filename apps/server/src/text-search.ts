/** Literal lexical terms, never intent classification. All identifiers below
 * are fixed host SQL expressions, not request parameters. Short CJK terms need
 * substring matching because unicode61 does not segment Chinese words and the
 * trigram tokenizer requires at least three characters. */
export function textSearch(query:string,index:{id:string;text:string;words:string;trigrams:string}){
  const values:string[]=[];
  const clauses=query.trim().slice(0,1000).split(/\s+/u).filter(Boolean).slice(0,12).map(term=>{
    const quoted='"'+term.replaceAll('"','""')+'"';
    values.push(quoted);
    const words=`${index.id} IN (SELECT id FROM ${index.words} WHERE ${index.words} MATCH ?)`;
    if(Array.from(term).length>=3){values.push(quoted);return `(${words} OR ${index.id} IN (SELECT id FROM ${index.trigrams} WHERE ${index.trigrams} MATCH ?))`;}
    values.push(term);return `(${words} OR instr(lower(${index.text}),lower(?))>0)`;
  });
  return {sql:clauses.length?clauses.join(' AND '):'1',values};
}
