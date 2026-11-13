import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uploadDeadline } from './upload-progress.js';
test('slow transfer survives former three minute timeout while bytes progress',()=>{
  assert.equal(uploadDeadline({stage:'upload',changed:270000},280000,0),null);
});
test('stalled transfer and bounded total are distinguished',()=>{
  assert.equal(uploadDeadline({stage:'upload',changed:1000},122000,0),'upload_no_progress_timeout');
  assert.equal(uploadDeadline({stage:'upload',changed:1200001},1200001,0),'upload_total_timeout');
});
test('material and canvas have independent deadlines after upload',()=>{
  assert.equal(uploadDeadline({stage:'canvas',stageSince:280000},400000,0),null);
  assert.equal(uploadDeadline({stage:'canvas',stageSince:280000},461000,0),'canvas_timeout');
  assert.equal(uploadDeadline({stage:'material',stageSince:280000},461000,0),'material_timeout');
});
