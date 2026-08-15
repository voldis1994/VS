import { runCapitalDemoVerify } from './capitalDemoVerify.js';

const r = await runCapitalDemoVerify();
console.log(JSON.stringify(r, null, 2));
if (r.status === 'FAIL') process.exit(1);
if (r.status === 'EXTERNAL_BLOCKER') process.exit(2);
process.exit(0);
