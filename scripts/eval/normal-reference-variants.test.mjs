import {test} from 'node:test';import assert from 'node:assert/strict';
import {heldout} from './learning-transfer-fixtures.mjs';import {normalReferenceVariants} from './normal-reference-variants.mjs';
test('feedback and unseen normal probes are distinct and leave the original fixture unchanged',()=>{
 for(const c of heldout){const original=c.reference,v=normalReferenceVariants(c);assert.notEqual(v.feedback.source,original);assert.notEqual(v.probe.source,original);assert.notEqual(v.feedback.source,v.probe.source);assert.equal(c.reference,original);}
 assert.throws(()=>normalReferenceVariants({id:'unknown',reference:''}),/No explicitly/);
 assert.throws(()=>normalReferenceVariants({id:'lease-pool',reference:''}),/exactly one/);
});
