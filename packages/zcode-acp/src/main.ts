import { ZcodeAcpAgent } from './acp-agent.ts'

// The spawned command: ACP on stdio, one ZCode app-server underneath.
// stdout carries frames only; diagnostics belong on stderr.
new ZcodeAcpAgent().start()
