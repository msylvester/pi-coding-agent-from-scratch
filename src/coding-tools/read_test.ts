import { createReadTool } from './read.js';

const read = createReadTool(process.cwd());
const result = await read.execute({ path: "package.json"  });

console.log(result.content[0].text);
console.log("---");
const sliced = await read.execute({ path: "package.json", offset: 1, limit: 3 });
console.log(sliced.content[0].text);
