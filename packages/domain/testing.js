// Subpath shim for `@serviceloop/domain/testing`.
//
// The repo compiles with classic `moduleResolution: node`, which does not read
// the `exports` map, so the subpath needs a real file at the package root.
// Two lines here beats changing module resolution for every package.
module.exports = require('./dist/testing/index.js');
