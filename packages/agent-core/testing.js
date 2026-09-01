// Subpath shim for `@serviceloop/agent-core/testing`.
//
// The repo compiles with classic `moduleResolution: node`, which does not read
// the `exports` map, so the subpath needs a real file at the package root — the
// same two lines `@serviceloop/domain/testing` needs.
module.exports = require('./dist/testing/index.js');
