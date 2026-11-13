import { AgentConsole } from '@/components/agent-console/agent-console'

// A bare agent console that exercises the agent runner directly, outside the
// master chat. Kept for the runner journeys in tests/agent-runner.spec.ts.
export default function AgentConsolePage() {
  return <AgentConsole />
}
