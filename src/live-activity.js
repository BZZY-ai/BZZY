import { recordActivity } from './activity.js';
import { redactedUrl } from './traffic.js';

const singleLine = text => String(text || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim();
function description(input) {
  const text = singleLine(input.description);
  if (!text || text.length > 180 || /[;`|<>]|\$\(|\b(?:curl|wget|bash|sudo|python\d?|node|npm|npx|rg|grep|authorization|password|api.?key|bearer)\b/i.test(text)) return '';
  return text.replace(/[.!]+$/, '');
}
export function humanActivity(name, input = {}, objective = '') {
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
  if (!input || typeof input !== 'object') input = {};
  const command = typeof input.command === 'string' ? input.command : '';
  let url, host;
  try {
    const candidate = input.url || /https?:\/\/[^\s'"`<>\\)]+/.exec(command)?.[0];
    const parsed = new URL(candidate);
    if (['http:', 'https:'].includes(parsed.protocol)) { url = redactedUrl(parsed.href); host = parsed.hostname; }
  } catch { /* A local step need not have a URL. */ }
  const web = /(?:WebFetch|http_request|browser.*(?:navigate|open)|web.*(?:fetch|open)|webSearch)/i.test(name) || host;
  const footer = /\bfooter\b/i.test(objective);
  let summary, details, category = 'work';
  if (footer && web && host) {
    summary = `Checking the footer on ${host}`;
    details = `I’m opening ${host} to locate the page’s footer and extract its text.`; category = 'web';
  } else if (footer && /footer|beautifulsoup|cheerio|html\.parser/i.test(command)) {
    summary = 'Extracting the footer text';
    details = 'I’m inspecting the page content to separate the footer text from the rest of the page.'; category = 'web';
  } else if (description(input)) {
    summary = description(input); details = `${summary}.`;
  } else if (web && host) {
    summary = `Reading the page on ${host}`;
    details = `I’m opening ${url} to inspect the page for the information in your request.`; category = 'web';
  } else if (/search/i.test(name) && !/shell|bash/i.test(name)) {
    summary = 'Looking for relevant information'; details = 'I’m searching for material that can help answer your request.'; category = 'research';
  } else if (/fileChange|edit|write|apply_patch/i.test(name)) {
    summary = 'Updating the relevant files'; details = 'I’m applying the changes needed for your request.'; category = 'coding';
  } else if (/\b(?:pytest|jest|vitest|cargo test|go test|npm test|npm run (?:test|check)|node --test|make check)\b/i.test(command)) {
    summary = 'Running the relevant checks'; details = 'I’m running the checks to establish which parts pass and what still needs attention.'; category = 'verification';
  } else if (/read|glob|grep/i.test(name) || /(?:^|[;&|]\s*)(?:cat|sed|head|tail|rg|grep|ls)\b/.test(command)) {
    summary = 'Reviewing the relevant files'; details = 'I’m reading the files and locating the parts relevant to your request.'; category = 'research';
  } else if (/shell|bash|commandExecution/i.test(name)) {
    summary = 'Checking the next part of your request'; details = 'I’m running a local check to collect the information needed for the next step.';
  } else return null;
  return { summary, details, category, target: url || null, status: 'running' };
}

export class ActivityReporter {
  constructor(session, ui, prompt = '') { this.session = session; this.ui = ui; this.prompt = prompt; }
  setPrompt(prompt) { this.prompt = prompt; }
  explicit(record) { this.explicitAt = Date.now(); this.lastSummary = record.summary; }
  tool(id, name, input) {
    if (/^(?:mcp__bzzy_goal__|activity$|checkpoint$|get_task_state$|get_goal$|update_goal$)/.test(name || '')) return;
    if (Date.now() - (this.explicitAt || 0) < 90000) return;
    const activity = humanActivity(name, input, this.prompt);
    if (!activity || activity.summary === this.lastSummary) return;
    this.lastSummary = activity.summary;
    try { return recordActivity(this.session, activity, this.ui, { provenance: 'host-inferred', source: 'native-tool', toolCallId: id || null }); }
    catch { this.ui.event('activity.unavailable', { reason: 'The live activity entry could not be saved.' }); }
  }
}
