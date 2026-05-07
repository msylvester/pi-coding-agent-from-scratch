import { resolveToCwd } from "./coding-tools/path-utils.js";
import { truncateHead } from "./coding-tools/truncate.js";

console.log(resolveToCwd("~/foo", "/bar"));        // -> /Users/.../foo
console.log(resolveToCwd("./baz", "/bar"));        // -> /bar/baz
const r = truncateHead("a\nb\nc\nd\n", { maxLines: 2 });
console.log(r);         
