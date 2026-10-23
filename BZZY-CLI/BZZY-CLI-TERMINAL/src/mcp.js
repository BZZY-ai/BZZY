import readline from 'node:readline';
import { readJson, sessionPath } from './store.js';
import { writeReport } from './goals.js';

export async function serveGoalTools(sessionId, nonce) {
  const tools = [
    { name: 'get_goal', description: 'Read the current persistent bzzy goal, usage, and lifecycle state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'update_goal', description: 'Report verified full completion, or a genuine recurring blocker. Never shrink the objective. Blocked requires the same condition across three consecutive turns; the host enforces this threshold.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['complete', 'blocked'] },
        evidence: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        blocker: { type: 'string', description: 'Required for blocked: a concise, stable description of the actual condition.' } }, required: ['status', 'evidence'], additionalProperties: false } },
  ];
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    let request;
    try {
      request = JSON.parse(line);
      if (request.id == null) continue;
      let result;
      if (request.method === 'initialize') {
        result = { protocolVersion: request.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'bzzy-goals', version: '0.2.0' } };
      } else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') result = { tools };
      else if (request.method === 'tools/call') {
        const session = readJson(sessionPath(sessionId));
        if (!session?.goal || session.goal.status !== 'active') throw new Error('There is no active goal.');
        if (request.params.name === 'get_goal') result = { content: [{ type: 'text', text: JSON.stringify(session.goal) }] };
        else if (request.params.name === 'update_goal') {
          writeReport(sessionId, nonce, request.params.arguments);
          result = { content: [{ type: 'text', text: 'Report recorded for this turn. Completion is a claim about the full objective. The supervisor will apply lifecycle and recurring-blocker checks.' }] };
        } else throw new Error('Unknown goal tool.');
      } else {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })}\n`);
        continue;
      }
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) {
      if (request?.id != null) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } })}\n`);
    }
  }
}
