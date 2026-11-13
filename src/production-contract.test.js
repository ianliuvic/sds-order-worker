import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cartLines,productionPlan,placement} from './production-contract.js';
test('inquiry sizes never silently become M x 1',()=>{
 assert.throws(()=>cartLines({source:'wordpress_inquiry',orders:[{size:'M',quantity:1}]}));
 assert.deepEqual(cartLines({source:'wordpress_inquiry',meta:{sizes:[{size:'S',quantity:2},{size:'L',quantity:3},{size:'S',quantity:4}]}}),[{size:'S',quantity:6},{size:'L',quantity:3}]);
 assert.throws(()=>cartLines({orders:[{size:'',quantity:1}]}));
});
test('multi-side all requires exact complete matching',()=>{
 const manifest={designProductId:'5116',modes:[{kind:'all',prototypeGroupId:7,sides:[{id:1,previewWidth:1000,previewHeight:616},{id:2,previewWidth:1000,previewHeight:616}]}]};
 const intake={modeKind:'all',meta:{prototypeGroupId:7},sides:[{sideId:'2',width:2000,height:1232},{sideId:'1',width:2000,height:1232}]};
 assert.deepEqual(productionPlan(intake,manifest).sides.map(s=>s.sourceSideId),['1','2']);
 assert.throws(()=>productionPlan({...intake,sides:intake.sides.slice(0,1)},manifest));
 assert.throws(()=>productionPlan({...intake,meta:{prototypeGroupId:8}},manifest));
});
test('placement preserves official crop instead of square stage',()=>{
 const p=placement({left:0,top:115.2,width:600,height:369.6},2000,1232);
 assert.equal(p.left,300);assert.equal(p.top,300);assert.ok(Math.abs(p.scaleX-.3)<1e-12);assert.ok(Math.abs(p.scaleY-.3)<1e-12);
});
test('BK2134 missing legacy sizes use SDS verified production dimensions',()=>{
 const ids=['10054679','10054680','10054681','10054682'];
 const manifest={designProductId:'8669',modes:[{kind:'single',prototypeGroupId:'7280',sides:ids.map(id=>({id,previewWidth:1200,previewHeight:840}))}]};
 const intake={productId:'8668',source:'wordpress_inquiry',modeKind:'single',meta:{prototypeGroupId:'7280'},sides:ids.map(sideId=>({sideId,width:3000,height:2100,mime:'image/png'}))};
 assert.equal(productionPlan(intake,manifest).sides.length,4);
 assert.throws(()=>productionPlan({...intake,sides:intake.sides.map(s=>({...s,width:900,height:900}))},manifest));
});
