import { writeFileSync } from 'node:fs'

const snapshotFile = process.argv[2]
if (snapshotFile === undefined) throw new Error('fake-env-snapshot requires an output file')

writeFileSync(snapshotFile, `${process.env.DSH_SESSION_ROOT ?? ''}\n`)
// Stay alive briefly so HoldWorker.close() can drain its pipes.
setTimeout(() => { process.exit(0) }, 50)
