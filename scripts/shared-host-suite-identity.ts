import { projectSuiteIdentity } from '@neutronai/open/wiring/project-build-dependencies.ts'

// Use the publication reader's complete contract, including its clean-tree
// requirement. Unknown inputs cannot establish a shared-host suite receipt.
if (process.argv.length !== 3) process.exit(2)
const identity = await projectSuiteIdentity(process.argv[2]!)
if (identity === null) process.exit(2)
console.log(identity)
