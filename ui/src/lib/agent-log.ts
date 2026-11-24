/** One entry of an agent's output as the log views show it. */
export interface AgentLog {
  timestamp: number;
  type: string;
  content: unknown;
}
