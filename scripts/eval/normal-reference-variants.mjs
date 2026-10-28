/** Fixed contract-preserving controls. Never part of the model's input or the hidden score. */
const replaceOne=(source,from,to)=>{
 if(source.split(from).length!==2)throw Error('Expected exactly one unchanged reference expression');
 return source.replace(from,to);
};
export function normalReferenceVariants(c){
 if(c.id==='lease-pool'){
  const expression='return new(key,0,Task.FromCanceled<string>(cancellationToken))';
  return{feedback:{id:'cancelled-generation-min',source:replaceOne(c.reference,expression,'return new(key,long.MinValue,Task.FromCanceled<string>(cancellationToken))')},probe:{id:'cancelled-generation-neg17',source:replaceOne(c.reference,expression,'return new(key,-17,Task.FromCanceled<string>(cancellationToken))')}};
 }
 if(c.id==='ledger-writer'){
  const expression='new ReadOnlyDictionary<string,int>(new Dictionary<string,int>(_values,StringComparer.Ordinal))';
  return{feedback:{id:'detached-sorted-snapshot',source:replaceOne(c.reference,expression,'new ReadOnlyDictionary<string,int>(new SortedDictionary<string,int>(_values,StringComparer.Ordinal))')},probe:{id:'detached-reverse-snapshot',source:replaceOne(c.reference,expression,'new ReadOnlyDictionary<string,int>(new Dictionary<string,int>(_values.Reverse(),StringComparer.Ordinal))')}};
 }
 throw Error('No explicitly reviewed normal reference variant for '+c.id);
}
